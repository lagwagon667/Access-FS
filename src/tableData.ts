export interface AccessTableColumn {
    name: string;
    type: number;
    attributes: number;
    size: number;
    decimalPlaces: number;
    required: boolean;
}

export interface AccessTableIndex {
    name: string;
    primary: boolean;
    unique: boolean;
    fields: { name: string; descending: boolean }[];
}

export interface ParsedTableSql {
    tableName: string;
    createStatement: string;
    columns: AccessTableColumn[];
    indexes: AccessTableIndex[];
    indexStatements: string[];
    rows: unknown[][];
}

export interface TableSqlIssue {
    message: string;
    start: number;
    end: number;
    severity: 'error' | 'warning';
}

interface AccessDateValue {
    $accessfs: 'date';
    value: string;
}

export function formatTableSql(
    tableName: string,
    columns: AccessTableColumn[],
    rows: Record<string, unknown>[],
    indexes: AccessTableIndex[] = [],
): string {
    const columnDefinitions = columns.map(column =>
        `    ${quoteIdentifier(column.name)} ${getSqlType(column)}${column.required ? ' NOT NULL' : ''}`,
    );
    const statements = [
        `CREATE TABLE ${quoteIdentifier(tableName)} (\n${columnDefinitions.join(',\n')}\n);`,
        ...indexes.map(index => formatIndexStatement(tableName, index)),
        ...rows.map(row =>
            `INSERT INTO ${quoteIdentifier(tableName)} (${columns.map(column => quoteIdentifier(column.name)).join(', ')})\n`
            + `VALUES (${columns.map(column => formatSqlValue(row[column.name], tableName, column.name)).join(', ')});`,
        ),
    ];
    return `${statements.join('\n\n')}\n`;
}

export function parseTableSql(
    content: string,
): ParsedTableSql {
    const statements = splitStatements(content);
    const createStatement = statements.shift()?.trim();
    if (!createStatement) {
        throw new Error('Table SQL must start with a CREATE TABLE statement.');
    }
    const { tableName, columns } = parseCreateTable(createStatement);

    const indexes: AccessTableIndex[] = [];
    const rows: unknown[][] = [];
    for (const [statementIndex, statement] of statements.entries()) {
        if (/^CREATE\s+(?:UNIQUE\s+)?INDEX\b/i.test(statement)) {
            indexes.push(parseIndexStatement(statement, tableName, columns));
            continue;
        }
        rows.push(parseInsertStatement(statement, statementIndex, tableName, columns));
    }
    const normalizedIndexNames = indexes.map(index => index.name.toLowerCase());
    if (new Set(normalizedIndexNames).size !== normalizedIndexNames.length) {
        throw new Error(`Table "${tableName}" contains duplicate index names.`);
    }
    if (indexes.filter(index => index.primary).length > 1) {
        throw new Error(`Table "${tableName}" cannot have more than one primary key.`);
    }
    const indexStatements = statements
        .filter(statement => /^CREATE\s+(?:UNIQUE\s+)?INDEX\b/i.test(statement))
        .map(statement => statement.trim());
    return { tableName, createStatement, columns, indexes, indexStatements, rows };
}

export function validateTableSql(content: string, expectedTableName: string): TableSqlIssue[] {
    let statements: StatementRange[];
    try {
        statements = splitStatementsWithOffsets(content);
    } catch (error) {
        return [{
            message: error instanceof Error ? error.message : String(error),
            start: 0,
            end: content.length,
            severity: 'error',
        }];
    }

    if (!statements.length || !/^CREATE\s+TABLE\b/i.test(statements[0].text)) {
        const firstStatement = statements[0];
        return [{
            message: 'Table SQL must start with a CREATE TABLE statement.',
            start: firstStatement?.start ?? 0,
            end: firstStatement?.end ?? content.length,
            severity: 'error',
        }];
    }

    try {
        const parsed = parseTableSql(content);
        if (parsed.tableName.toLowerCase() !== expectedTableName.toLowerCase()) {
            return [{
                message: `CREATE TABLE name "${parsed.tableName}" must match the file name "${expectedTableName}".`,
                start: statements[0].start,
                end: statements[0].end,
                severity: 'error',
            }];
        }
        const issues: TableSqlIssue[] = [];
        for (const statement of statements.slice(1)) {
            if (!/^INSERT\s+INTO\b/i.test(statement.text)) {
                continue;
            }
            const insertPrefix = /^INSERT\s+INTO\s+/i.exec(statement.text);
            if (!insertPrefix) {
                continue;
            }
            const tableIdentifier = readBracketedIdentifier(statement.text, insertPrefix[0].length);
            const insert = /^\s*\(([\s\S]*?)\)\s*VALUES\b/i.exec(statement.text.slice(tableIdentifier.end));
            if (!insert) {
                continue;
            }
            const specifiedColumns = new Set(
                splitCommaSeparated(insert[1]).map(column => parseIdentifier(column.trim()).toLowerCase()),
            );
            const missingColumns = parsed.columns
                .filter(column => !specifiedColumns.has(column.name.toLowerCase()))
                .map(column => column.name);
            if (missingColumns.length) {
                issues.push({
                    message: `INSERT does not specify all CREATE TABLE columns. Missing: ${missingColumns.join(', ')}.`,
                    start: statement.start,
                    end: statement.end,
                    severity: 'warning',
                });
            }
        }
        return issues;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const statementNumber = /(?:Statement|statement)\s+(\d+)/.exec(message);
        let problemStatement: StatementRange | undefined;
        if (statementNumber) {
            problemStatement = statements[Number(statementNumber[1]) - 1];
        } else if (/index/i.test(message)) {
            problemStatement = statements.find(statement => /^CREATE\s+(?:UNIQUE\s+)?INDEX\b/i.test(statement.text));
        } else {
            problemStatement = statements[0];
        }
        return [{
            message,
            start: problemStatement?.start ?? 0,
            end: problemStatement?.end ?? content.length,
            severity: 'error',
        }];
    }
}

export function renameTableSql(content: string, newTableName: string): string {
    const parsed = parseTableSql(content);
    if (parsed.tableName.toLowerCase() === newTableName.toLowerCase()) {
        return content;
    }
    const rows = parsed.rows.map(row => Object.fromEntries(
        parsed.columns.map((column, index) => [column.name, row[index]]),
    ));
    return formatTableSql(newTableName, parsed.columns, rows, parsed.indexes);
}

export function sameTableIndexes(left: AccessTableIndex[], right: AccessTableIndex[]): boolean {
    const normalize = (indexes: AccessTableIndex[]) => indexes
        .map(index => ({
            name: index.name.toLowerCase(),
            primary: index.primary,
            unique: index.unique,
            fields: index.fields.map(field => ({
                name: field.name.toLowerCase(),
                descending: field.descending,
            })),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
    return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

function formatIndexStatement(tableName: string, index: AccessTableIndex): string {
    const unique = index.unique || index.primary ? 'UNIQUE ' : '';
    const fields = index.fields
        .map(field => `${quoteIdentifier(field.name)}${field.descending ? ' DESC' : ''}`)
        .join(', ');
    const primary = index.primary ? ' WITH PRIMARY' : '';
    return `CREATE ${unique}INDEX ${quoteIdentifier(index.name)} ON ${quoteIdentifier(tableName)} (${fields})${primary};`;
}

function parseIndexStatement(
    statement: string,
    tableName: string,
    columns: AccessTableColumn[],
): AccessTableIndex {
    const prefix = /^CREATE\s+(UNIQUE\s+)?INDEX\s+/i.exec(statement);
    if (!prefix) {
        throw new Error('Unsupported index statement.');
    }
    const indexIdentifier = readBracketedIdentifier(statement, prefix[0].length);
    const afterIndexName = statement.slice(indexIdentifier.end);
    const onClause = /^\s+ON\s+/i.exec(afterIndexName);
    if (!onClause) {
        throw new Error(`Index "${indexIdentifier.name}" must specify its table with ON.`);
    }
    const tableIdentifier = readBracketedIdentifier(afterIndexName, onClause[0].length);
    const fieldList = afterIndexName.slice(tableIdentifier.end).trim();
    const fieldMatch = /^\(([\s\S]*)\)(?:\s+WITH\s+(PRIMARY))?$/i.exec(fieldList);
    if (!fieldMatch || tableIdentifier.name.toLowerCase() !== tableName.toLowerCase()) {
        throw new Error(`Index statement must define an index for table "${tableName}".`);
    }
    const fields = splitCommaSeparated(fieldMatch[1]).map(definition => {
        const trimmedDefinition = definition.trim();
        const fieldIdentifier = readBracketedIdentifier(trimmedDefinition, 0);
        const sortOrder = /^\s*(ASC|DESC)?\s*$/i.exec(trimmedDefinition.slice(fieldIdentifier.end));
        if (!sortOrder) {
            throw new Error(`Unsupported index field definition "${definition.trim()}".`);
        }
        const name = fieldIdentifier.name;
        if (!columns.some(column => column.name.toLowerCase() === name.toLowerCase())) {
            throw new Error(`Index references unknown field "${name}" in table "${tableName}".`);
        }
        return { name, descending: sortOrder[1]?.toUpperCase() === 'DESC' };
    });
    if (fields.length === 0) {
        throw new Error(`Index "${indexIdentifier.name}" must include at least one field.`);
    }
    const primary = Boolean(fieldMatch[2]);
    const unique = Boolean(prefix[1]) || primary;
    return {
        name: indexIdentifier.name,
        primary,
        unique,
        fields,
    };
}

function parseInsertStatement(
    statement: string,
    statementIndex: number,
    tableName: string,
    columns: AccessTableColumn[],
): unknown[] {
    const match = /^INSERT\s+INTO\s+\[([^\]]*(?:\]\][^\]]*)*)\]\s*\(([\s\S]*?)\)\s*VALUES\s*\(([\s\S]*)\)$/i.exec(
        statement.trim(),
    );
    if (!match || unquoteIdentifier(match[1]).toLowerCase() !== tableName.toLowerCase()) {
        throw new Error(`Statement ${statementIndex + 2} must be an INSERT for table "${tableName}".`);
    }

    const insertColumns = splitCommaSeparated(match[2]).map(value => parseIdentifier(value.trim()));
    const values = splitCommaSeparated(match[3]);
    if (values.length !== insertColumns.length) {
        throw new Error(`INSERT statement ${statementIndex + 2} has a different number of columns and values.`);
    }

    const valueByColumn = new Map<string, unknown>();
    for (let index = 0; index < insertColumns.length; index++) {
        const columnName = insertColumns[index];
        const normalizedColumnName = columnName.toLowerCase();
        if (valueByColumn.has(normalizedColumnName)) {
            throw new Error(`INSERT statement ${statementIndex + 2} lists "${columnName}" more than once.`);
        }
        const column = columns.find(candidate => candidate.name.toLowerCase() === normalizedColumnName);
        if (!column) {
            throw new Error(`INSERT statement ${statementIndex + 2} references unknown field "${columnName}".`);
        }
        valueByColumn.set(
            normalizedColumnName,
            parseSqlValue(values[index].trim(), tableName, columnName),
        );
    }

    const row = columns.map(column => {
        const normalizedColumnName = column.name.toLowerCase();
        if (valueByColumn.has(normalizedColumnName)) {
            return valueByColumn.get(normalizedColumnName);
        }
        if ((column.attributes & 16) !== 0) {
            return null;
        }
        if (!column.required) {
            return null;
        }
        throw new Error(`INSERT statement ${statementIndex + 2} is missing required field "${column.name}".`);
    });
    for (let index = 0; index < columns.length; index++) {
        validateFieldValue(columns[index], row[index], statementIndex + 2);
    }
    return row;
}

export function sameTableSchema(left: AccessTableColumn[], right: AccessTableColumn[]): boolean {
    return left.length === right.length && left.every((column, index) => {
        const other = right[index];
        const hasVariableSize = column.type === 10
            || column.type === 18
            || column.type === 19
            || column.type === 20;
        const hasVariablePrecision = column.type === 19 || column.type === 20;
        return column.name.toLowerCase() === other.name.toLowerCase()
            && column.type === other.type
            && (!hasVariableSize || column.size === other.size)
            && (!hasVariablePrecision || column.decimalPlaces === other.decimalPlaces)
            && column.required === other.required
            && (column.attributes & 16) === (other.attributes & 16);
    });
}

function validateFieldValue(column: AccessTableColumn, value: unknown, statementNumber: number): void {
    if (value === null) {
        if (column.required && (column.attributes & 16) === 0) {
            throw new Error(`INSERT statement ${statementNumber} sets required field "${column.name}" to NULL.`);
        }
        return;
    }

    const valid = (() => {
        switch (column.type) {
            case 1:
                return typeof value === 'boolean';
            case 2:
                return typeof value === 'number'
                    && Number.isInteger(value)
                    && value >= 0
                    && value <= 255;
            case 3:
                return typeof value === 'number'
                    && Number.isInteger(value)
                    && value >= -32768
                    && value <= 32767;
            case 4:
                return typeof value === 'number'
                    && Number.isInteger(value)
                    && value >= -2147483648
                    && value <= 2147483647;
            case 5:
            case 6:
            case 7:
            case 19:
            case 20:
            case 21:
                return typeof value === 'number' && Number.isFinite(value);
            case 8:
            case 22:
            case 23:
                return value instanceof Date && !Number.isNaN(value.getTime());
            case 10:
            case 12:
            case 15:
            case 18:
                return typeof value === 'string'
                    && (column.type !== 10 && column.type !== 18 || value.length <= column.size);
            default:
                return false;
        }
    })();
    if (!valid) {
        throw new Error(`INSERT statement ${statementNumber} has an invalid value for field "${column.name}".`);
    }
}

function parseCreateTable(statement: string): { tableName: string; columns: AccessTableColumn[] } {
    const prefix = /^CREATE\s+TABLE\s+/i.exec(statement);
    if (!prefix) {
        throw new Error('Table SQL must start with a supported CREATE TABLE statement.');
    }
    const identifier = readBracketedIdentifier(statement, prefix[0].length);
    const definitionList = statement.slice(identifier.end).trim();
    if (!definitionList.startsWith('(') || !definitionList.endsWith(')')) {
        throw new Error('Table SQL must start with a supported CREATE TABLE statement.');
    }
    const tableName = identifier.name;
    const definitions = splitCommaSeparated(definitionList.slice(1, -1));
    if (definitions.length === 0) {
        throw new Error(`CREATE TABLE "${tableName}" must define at least one field.`);
    }

    const columns = definitions.map(definition => parseColumnDefinition(definition, tableName));
    if (new Set(columns.map(column => column.name.toLowerCase())).size !== columns.length) {
        throw new Error(`CREATE TABLE "${tableName}" contains duplicate field names.`);
    }
    return { tableName, columns };
}

function parseColumnDefinition(definition: string, tableName: string): AccessTableColumn {
    const trimmedDefinition = definition.trim();
    const identifier = readBracketedIdentifier(trimmedDefinition, 0);
    const match = /^\s+([A-Z]+)(?:\s*\(\s*(\d+)\s*(?:,\s*(\d+)\s*)?\))?(?:\s+(NOT\s+NULL))?\s*$/i.exec(
        trimmedDefinition.slice(identifier.end),
    );
    if (!match) {
        throw new Error(`Unsupported field definition in CREATE TABLE "${tableName}": ${definition.trim()}`);
    }

    const name = identifier.name;
    const sqlType = match[1].toUpperCase();
    const size = Number(match[2] ?? 0);
    const decimalPlaces = Number(match[3] ?? 0);
    let type: number;
    let attributes = 0;

    switch (sqlType) {
        case 'COUNTER': type = 4; attributes |= 16; break;
        case 'YESNO': type = 1; break;
        case 'BYTE': type = 2; break;
        case 'SHORT': type = 3; break;
        case 'LONG': type = 4; break;
        case 'CURRENCY': type = 5; break;
        case 'SINGLE': type = 6; break;
        case 'DOUBLE': type = 7; break;
        case 'DATETIME': type = 8; break;
        case 'TEXT': type = 10; break;
        case 'MEMO': type = 12; break;
        case 'GUID': type = 15; break;
        case 'CHAR': type = 18; break;
        case 'NUMERIC': type = 19; break;
        case 'DECIMAL': type = 20; break;
        case 'FLOAT': type = 21; break;
        case 'TIME': type = 22; break;
        case 'TIMESTAMP': type = 23; break;
        default:
            throw new Error(`Unsupported SQL type "${sqlType}" for field "${name}" in table "${tableName}".`);
    }

    const fieldSize = match[2] === undefined
        ? defaultFieldSize(type)
        : size;
    return {
        name,
        type,
        attributes,
        size: fieldSize,
        decimalPlaces,
        required: Boolean(match[4]),
    };
}

function defaultFieldSize(type: number): number {
    switch (type) {
        case 1:
        case 2:
            return 1;
        case 3:
            return 2;
        case 8:
            return 8;
        case 4:
        case 6:
        case 21:
            return 4;
        case 5:
        case 7:
        case 22:
        case 23:
            return 8;
        case 10:
            return 255;
        case 15:
            return 16;
        case 18:
            return 1;
        case 19:
        case 20:
            return 18;
        default:
            return 0;
    }
}

function getSqlType(column: AccessTableColumn): string {
    if ((column.attributes & 16) !== 0) {
        return 'COUNTER';
    }

    switch (column.type) {
        case 1: return 'YESNO';
        case 2: return 'BYTE';
        case 3: return 'SHORT';
        case 4: return 'LONG';
        case 5: return 'CURRENCY';
        case 6: return 'SINGLE';
        case 7: return 'DOUBLE';
        case 8: return 'DATETIME';
        case 10: return `TEXT(${column.size})`;
        case 12: return 'MEMO';
        case 15: return 'GUID';
        case 18: return `CHAR(${column.size})`;
        case 19: return `NUMERIC(${column.size}, ${column.decimalPlaces})`;
        case 20: return `DECIMAL(${column.size}, ${column.decimalPlaces})`;
        case 21: return 'FLOAT';
        case 22: return 'TIME';
        case 23: return 'TIMESTAMP';
        default:
            throw new Error(`Unsupported Access DAO field type ${column.type} for "${column.name}".`);
    }
}

function formatSqlValue(value: unknown, tableName: string, columnName: string): string {
    if (value === null || value === undefined) {
        return 'NULL';
    }
    if (typeof value === 'string') {
        return `'${value.replace(/'/g, "''")}'`;
    }
    if (typeof value === 'boolean') {
        return value ? 'TRUE' : 'FALSE';
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
        return String(value);
    }
    if (isAccessDateValue(value)) {
        const date = new Date(value.value);
        if (Number.isNaN(date.getTime())) {
            throw new Error(`Field "${columnName}" in table "${tableName}" has an invalid date.`);
        }
        return `#${date.toISOString().slice(0, 19).replace('T', ' ')}#`;
    }
    throw new Error(`Field "${columnName}" in table "${tableName}" contains an unsupported value.`);
}

function parseSqlValue(value: string, tableName: string, columnName: string): unknown {
    if (/^NULL$/i.test(value)) {
        return null;
    }
    if (/^(TRUE|FALSE)$/i.test(value)) {
        return value.toUpperCase() === 'TRUE';
    }
    if (/^'(?:[^']|'')*'$/.test(value)) {
        return value.slice(1, -1).replace(/''/g, "'");
    }
    if (/^#[\d-]{4,10}[-/][\d-]{2,10}(?:\s+\d{1,2}:\d{2}:\d{2})?#$/.test(value)) {
        const date = new Date(value.slice(1, -1).replace(' ', 'T') + 'Z');
        if (!Number.isNaN(date.getTime())) {
            return date;
        }
    }
    if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value)) {
        const number = Number(value);
        if (Number.isFinite(number)) {
            return number;
        }
    }
    throw new Error(`Value for field "${columnName}" in table "${tableName}" is not a supported SQL literal.`);
}

interface StatementRange {
    text: string;
    start: number;
    end: number;
}

function splitStatements(sql: string): string[] {
    return splitStatementsWithOffsets(sql).map(statement => statement.text);
}

function splitStatementsWithOffsets(sql: string): StatementRange[] {
    const statements: StatementRange[] = [];
    let start = 0;
    let inString = false;
    let inDate = false;
    let inIdentifier = false;

    for (let index = 0; index < sql.length; index++) {
        const character = sql[index];
        if (inString && character === "'" && sql[index + 1] === "'") {
            index++;
            continue;
        }
        if (character === "'" && !inDate && !inIdentifier) {
            inString = !inString;
        } else if (character === '#' && !inString && !inIdentifier) {
            inDate = !inDate;
        } else if (character === '[' && !inString && !inDate) {
            inIdentifier = true;
        } else if (character === ']' && inIdentifier && sql[index + 1] === ']') {
            index++;
        } else if (character === ']' && inIdentifier) {
            inIdentifier = false;
        } else if (character === ';' && !inString && !inDate && !inIdentifier) {
            const segment = sql.slice(start, index);
            const statement = segment.trim();
            if (statement) {
                const leadingWhitespace = segment.length - segment.trimStart().length;
                statements.push({
                    text: statement,
                    start: start + leadingWhitespace,
                    end: start + leadingWhitespace + statement.length,
                });
            }
            start = index + 1;
        }
    }

    if (inString || inDate || inIdentifier) {
        throw new Error('Table SQL contains an unterminated string, date, or identifier.');
    }
    const trailingSegment = sql.slice(start);
    const trailingStatement = trailingSegment.trim();
    if (trailingStatement) {
        const leadingWhitespace = trailingSegment.length - trailingSegment.trimStart().length;
        statements.push({
            text: trailingStatement,
            start: start + leadingWhitespace,
            end: start + leadingWhitespace + trailingStatement.length,
        });
    }
    return statements;
}

function splitCommaSeparated(value: string): string[] {
    const values: string[] = [];
    let start = 0;
    let parenthesisDepth = 0;
    let inString = false;
    let inDate = false;
    let inIdentifier = false;

    for (let index = 0; index < value.length; index++) {
        const character = value[index];
        if (inString && character === "'" && value[index + 1] === "'") {
            index++;
            continue;
        }
        if (character === "'" && !inDate && !inIdentifier) {
            inString = !inString;
        } else if (character === '#' && !inString && !inIdentifier) {
            inDate = !inDate;
        } else if (character === '[' && !inString && !inDate) {
            inIdentifier = true;
        } else if (character === ']' && inIdentifier && value[index + 1] === ']') {
            index++;
        } else if (character === ']' && inIdentifier) {
            inIdentifier = false;
        } else if (!inString && !inDate && !inIdentifier && character === '(') {
            parenthesisDepth++;
        } else if (!inString && !inDate && !inIdentifier && character === ')') {
            parenthesisDepth--;
            if (parenthesisDepth < 0) {
                throw new Error('Table SQL contains an unmatched closing parenthesis.');
            }
        } else if (
            character === ','
            && !inString
            && !inDate
            && !inIdentifier
            && parenthesisDepth === 0
        ) {
            values.push(value.slice(start, index).trim());
            start = index + 1;
        }
    }
    if (parenthesisDepth !== 0) {
        throw new Error('Table SQL contains an unterminated parenthesis.');
    }
    values.push(value.slice(start).trim());
    return values;
}

function parseIdentifier(value: string): string {
    const identifier = readBracketedIdentifier(value, 0);
    if (identifier.end !== value.length) {
        throw new Error(`Invalid SQL identifier "${value}".`);
    }
    return identifier.name;
}

function readBracketedIdentifier(value: string, start: number): { name: string; end: number } {
    if (value[start] !== '[') {
        throw new Error(`Invalid SQL identifier "${value}".`);
    }
    let rawIdentifier = '';
    for (let index = start + 1; index < value.length; index++) {
        if (value[index] !== ']') {
            rawIdentifier += value[index];
            continue;
        }
        if (value[index + 1] === ']') {
            rawIdentifier += ']';
            index++;
            continue;
        }
        return { name: rawIdentifier, end: index + 1 };
    }
    throw new Error(`Invalid SQL identifier "${value}".`);
}

function quoteIdentifier(value: string): string {
    return `[${value.replace(/]/g, ']]')}]`;
}

function unquoteIdentifier(value: string): string {
    return value.replace(/\]\]/g, ']');
}

function isAccessDateValue(value: unknown): value is AccessDateValue {
    return typeof value === 'object'
        && value !== null
        && '$accessfs' in value
        && value.$accessfs === 'date'
        && 'value' in value
        && typeof value.value === 'string';
}
