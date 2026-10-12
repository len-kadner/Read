const MAX_SEARCH_BYTES = 2 * 1024 * 1024;
const MAX_TREE_BYTES = 4 * 1024 * 1024;
const MAX_BOOK_BYTES = 25 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 25000;

function sendError(res, status, message) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(status).json({ error: message });
}

function decodeTextBytes(bytes, contentType) {
    let offset = 0;
    let encoding = contentType.match(/charset=["']?([^;"'\s]+)/i)?.[1];
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
        encoding = 'utf-8';
        offset = 3;
    } else if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
        encoding = 'utf-16le';
        offset = 2;
    } else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
        encoding = 'utf-16be';
        offset = 2;
    }

    const content = bytes.subarray(offset);
    if (encoding) {
        try {
            return new TextDecoder(encoding, { fatal: true }).decode(content);
        } catch (error) {
            if (!['utf-8', 'utf8'].includes(encoding.toLowerCase())) throw error;
        }
    } else {
        try {
            return new TextDecoder('utf-8', { fatal: true }).decode(content);
        } catch {
            // Older Gutenberg mirror files may still use a single-byte encoding.
        }
    }
    return new TextDecoder('windows-1252', { fatal: true }).decode(content);
}

async function readLimitedBody(response, maxBytes) {
    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
        throw new Error('Die Antwort des Anbieters überschreitet die erlaubte Größe.');
    }
    if (!response.body) return '';

    const reader = response.body.getReader();
    const chunks = [];
    let totalBytes = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
            await reader.cancel();
            throw new Error('Die Antwort des Anbieters überschreitet die erlaubte Größe.');
        }
        chunks.push(value);
    }

    const content = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
        content.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return decodeTextBytes(content, response.headers.get('content-type') || '');
}

async function fetchText(url, maxBytes, headers = {}) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
    try {
        const response = await fetch(url, {
            signal: controller.signal,
            redirect: 'error',
            headers: { 'User-Agent': 'READ-Lese-App/1.0', ...headers }
        });
        if (!response.ok) {
            const error = new Error(`Der Anbieter antwortete mit HTTP ${response.status}.`);
            error.statusCode = response.status;
            throw error;
        }
        return await readLimitedBody(response, maxBytes);
    } catch (error) {
        if (controller.signal.aborted) throw new Error('Zeitüberschreitung beim Anbieter.');
        throw error;
    } finally {
        clearTimeout(timeoutId);
    }
}

function getBookTextFile(files, bookId) {
    const textFiles = files.filter(file => file.type === 'file' && file.name.toLowerCase().endsWith('.txt'));
    return textFiles.find(file => file.name === `${bookId}-0.txt`)
        || textFiles.find(file => file.name === `${bookId}.txt`)
        || textFiles.find(file => new RegExp(`^${bookId}-\\d+\\.txt$`, 'i').test(file.name))
        || textFiles.find(file => new RegExp(`^${bookId}[^/]*\\.txt$`, 'i').test(file.name));
}

module.exports = async function handler(req, res) {
    if (req.method !== 'GET') {
        res.setHeader('Allow', 'GET');
        return sendError(res, 405, 'Nur GET-Anfragen sind erlaubt.');
    }

    const action = typeof req.query.action === 'string' ? req.query.action : '';
    try {
        if (action === 'search') {
            const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
            if (!query || query.length > 150) {
                return sendError(res, 400, 'Bitte gib einen Buchtitel mit höchstens 150 Zeichen ein.');
            }

            const url = new URL('https://api.github.com/search/repositories');
            url.searchParams.set('q', `${query} org:GITenberg`);
            url.searchParams.set('per_page', '10');
            const body = await fetchText(url, MAX_SEARCH_BYTES, {
                Accept: 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28'
            });
            const catalog = JSON.parse(body);
            if (!catalog || !Array.isArray(catalog.items)) {
                return sendError(res, 502, 'Die GITenberg-Suche hat eine ungültige Antwort geliefert.');
            }

            const results = catalog.items.flatMap(repository => {
                if (repository.owner?.login !== 'GITenberg' || typeof repository.name !== 'string') return [];
                const bookId = repository.name.match(/_(\d+)$/)?.[1];
                if (!bookId) return [];
                const description = typeof repository.description === 'string' ? repository.description : '';
                const metadata = description.match(/^(.+?)\s+by\s+(.+?)(?:\r?\n|$)/i);
                const title = metadata?.[1]?.trim() || repository.name.replace(/_\d+$/, '').replace(/-/g, ' ');
                const author = metadata?.[2]?.trim().replace(/\s+is a Project Gutenberg book.*$/i, '') || '';
                return [{
                    repo: repository.name,
                    branch: repository.default_branch || 'master',
                    title,
                    author,
                    bookId,
                    subjects: Array.isArray(repository.topics) ? repository.topics : []
                }];
            });

            res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300');
            return res.status(200).json({ results });
        }

        if (action === 'book') {
            const repository = typeof req.query.repo === 'string' ? req.query.repo : '';
            const match = repository.match(/^([A-Za-z0-9-]+_\d+)@([A-Za-z0-9._-]+)$/);
            if (!match || match[2] === '.' || match[2] === '..') {
                return sendError(res, 400, 'Das ausgewählte GITenberg-Buch ist ungültig.');
            }

            const [, repo, branch] = match;
            const bookId = repo.match(/_(\d+)$/)[1];
            const treeUrl = `https://data.jsdelivr.com/v1/package/gh/GITenberg/${repo}@${branch}`;
            const tree = JSON.parse(await fetchText(treeUrl, MAX_TREE_BYTES));
            if (!Array.isArray(tree.files)) {
                return sendError(res, 502, 'Der jsDelivr-Spiegel hat keine gültige Dateiliste geliefert.');
            }

            const textFile = getBookTextFile(tree.files, bookId);
            if (!textFile) {
                return sendError(res, 404, 'Keine TXT-Datei für dieses Buch im jsDelivr-Spiegel gefunden.');
            }

            const fileUrl = new URL(`https://cdn.jsdelivr.net/gh/GITenberg/${repo}@${branch}/${encodeURIComponent(textFile.name)}`);
            const text = await fetchText(fileUrl, MAX_BOOK_BYTES);
            res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=86400');
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.setHeader('X-Content-Type-Options', 'nosniff');
            return res.status(200).send(text);
        }

        return sendError(res, 400, 'Aktion muss „search“ oder „book“ sein.');
    } catch (error) {
        console.error('Gutenberg-Spiegel-Abruf fehlgeschlagen:', error);
        const statusCode = Number.isInteger(error.statusCode) ? error.statusCode : 502;
        return sendError(res, statusCode, error.message || 'Der jsDelivr-Spiegel ist nicht erreichbar.');
    }
};
