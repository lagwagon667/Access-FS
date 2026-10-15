interface CountableCollection {
    Count?: unknown;
    count?: unknown;
}

export function getComCollectionCount(collection: CountableCollection, description: string): number {
    let count = collection.Count ?? collection.count;
    if (typeof count === 'function') {
        count = count.call(collection);
    }

    if (
        (typeof count !== 'number' && typeof count !== 'string')
        || (typeof count === 'string' && count.trim() === '')
    ) {
        throw new Error(`Could not read the item count from the Access ${description} collection.`);
    }

    const numericCount = Number(count);
    if (!Number.isSafeInteger(numericCount) || numericCount < 0) {
        throw new Error(`Access returned an invalid item count for the ${description} collection.`);
    }
    return numericCount;
}
