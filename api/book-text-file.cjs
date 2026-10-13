function findBookTextFile(files, bookId) {
    const textFiles = files.filter(file => file.type === 'file' && file.name.toLowerCase().endsWith('.txt'));
    return textFiles.find(file => file.name === `${bookId}-0.txt`)
        || textFiles.find(file => file.name === `${bookId}.txt`)
        || textFiles.find(file => new RegExp(`^${bookId}-\\d+\\.txt$`, 'i').test(file.name))
        || textFiles.find(file => new RegExp(`^${bookId}[^/]*\\.txt$`, 'i').test(file.name));
}

module.exports = findBookTextFile;
