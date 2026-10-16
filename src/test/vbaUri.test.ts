import * as assert from 'assert';
import * as path from 'path';
import { toFilePath, toFileUri } from '../vbaUri';

suite('VBA language server URI handling', () => {
	test('preserves virtual Access URIs instead of converting them to disk paths', () => {
		const uri = 'accessfs://database/modules/modExample.bas';

		assert.strictEqual(toFilePath(uri), uri);
		assert.strictEqual(toFileUri(uri), uri);
	});

	test('round-trips regular file paths through file URIs', () => {
		const filePath = path.resolve('modules', 'Example Module.bas');

		assert.strictEqual(toFilePath(toFileUri(filePath)), filePath);
	});
});
