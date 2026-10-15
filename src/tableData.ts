export interface AccessTableColumn {
    name: string;
    type: number;
    attributes: number;
}

export function parseTableData(
    content: string,
    tableName: string,
    columns: AccessTableColumn[],
): unknown[][] {
    let parsed: unknown;
    try {
        parsed = JSON.parse(content);
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`Invalid table JSON: ${detail}`);
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('Table content must be a JSON object.');
    }
    const document = parsed as {
        format?: unknown;
        table?: unknown;
        columns?: unknown;
        rows?: unknown;
    };
    if (document.format !== 'accessfs-table-v1' || document.table !== tableName) {
        throw new Error(
            `Table content must use format "accessfs-table-v1" and identify table "${tableName}".`,
        );
    }
    if (
        !Array.isArray(document.columns)
        || document.columns.length !== columns.length
        || document.columns.some((column, index) =>
            typeof column !== 'object'
            || column === null
            || !('name' in column)
            || column.name !== columns[index].name
            || !('type' in column)
            || column.type !== columns[index].type
            || !('attributes' in column)
            || column.attributes !== columns[index].attributes)
    ) {
        throw new Error(
            `The schema in the table document does not match "${tableName}". Table schema changes are not supported.`,
        );
    }
    if (!Array.isArray(document.rows)) {
        throw new Error('Table content must include a rows array.');
    }

    return document.rows.map((row, rowIndex) => {
        if (typeof row !== 'object' || row === null || Array.isArray(row)) {
            throw new Error(`Row ${rowIndex + 1} must be a JSON object.`);
        }
        const rowObject = row as Record<string, unknown>;
        const keys = Object.keys(rowObject);
        if (
            keys.length !== columns.length
            || columns.some(column => !Object.prototype.hasOwnProperty.call(rowObject, column.name))
        ) {
            throw new Error(
                `Row ${rowIndex + 1} must contain exactly the fields defined by table "${tableName}".`,
            );
        }
        return columns.map(column => parseTableValue(rowObject[column.name], tableName, column.name));
    });
}

function parseTableValue(value: unknown, tableName: string, columnName: string): unknown {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') {
        return value;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }
    if (
        typeof value === 'object'
        && value !== null
        && !Array.isArray(value)
        && '$accessfs' in value
        && value.$accessfs === 'date'
        && 'value' in value
        && typeof value.value === 'string'
    ) {
        const date = new Date(value.value);
        if (!Number.isNaN(date.getTime())) {
            return date;
        }
    }
    throw new Error(`Field "${columnName}" in table "${tableName}" contains an unsupported JSON value.`);
}
