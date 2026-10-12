const MAX_CATALOG_BYTES = 8 * 1024 * 1024;
const MAX_BOOK_BYTES = 25 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 25000;

function sendError(res, status, message) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(status).json({ error: message });
}

async function readLimitedBody(response, maxBytes) {
    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
        throw new Error('Die Antwort von Standard Ebooks überschreitet die erlaubte Größe.');
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
            throw new Error('Die Antwort von Standard Ebooks überschreitet die erlaubte Größe.');
        }
        chunks.push(value);
    }

    const content = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
        content.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return new TextDecoder('utf-8').decode(content);
}

async function fetchStandardEbooks(url, maxBytes) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
    try {
        const response = await fetch(url, {
            signal: controller.signal,
            redirect: 'error',
            headers: { 'User-Agent': 'READ-Lese-App/1.0' }
        });
        if (!response.ok) {
            const error = new Error(`Standard Ebooks antwortete mit HTTP ${response.status}.`);
            error.statusCode = response.status;
            throw error;
        }
        return await readLimitedBody(response, maxBytes);
    } catch (error) {
        if (controller.signal.aborted) throw new Error('Zeitüberschreitung bei Standard Ebooks.');
        throw error;
    } finally {
        clearTimeout(timeoutId);
    }
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

            const url = new URL('https://standardebooks.org/ebooks');
            url.searchParams.set('query', query);
            const html = await fetchStandardEbooks(url, MAX_CATALOG_BYTES);
            res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300');
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.setHeader('X-Content-Type-Options', 'nosniff');
            return res.status(200).send(html);
        }

        if (action === 'book') {
            const slug = typeof req.query.slug === 'string' ? req.query.slug : '';
            if (!/^[a-z0-9-]+\/[a-z0-9-]+$/i.test(slug)) {
                return sendError(res, 400, 'Der Standard-Ebooks-Buchtitel ist ungültig.');
            }

            const url = new URL(`https://standardebooks.org/ebooks/${slug}/text/single-page`);
            const html = await fetchStandardEbooks(url, MAX_BOOK_BYTES);
            res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=86400');
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.setHeader('X-Content-Type-Options', 'nosniff');
            return res.status(200).send(html);
        }

        return sendError(res, 400, 'Aktion muss „search“ oder „book“ sein.');
    } catch (error) {
        console.error('Standard-Ebooks-Abruf fehlgeschlagen:', error);
        const statusCode = Number.isInteger(error.statusCode) ? error.statusCode : 502;
        return sendError(res, statusCode, error.message || 'Standard Ebooks ist nicht erreichbar.');
    }
};
