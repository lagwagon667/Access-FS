// Core
import { toFilePath, toFileUri } from '../../vbaUri';

declare global {
	interface String {
		stripQuotes(): string;
		toFilePath(): string;
		toFileUri(): string;
		ciEquals(s: string): boolean;
	}
}

String.prototype.stripQuotes = function (): string {
	const exp = /^"?(.*?)"?$/;
	return exp.exec(this.toString())![1];
};

String.prototype.toFilePath = function (): string {
	return toFilePath(this.toString());
};

String.prototype.toFileUri = function (): string {
	return toFileUri(this.toString());
};

String.prototype.ciEquals = function (s: string): boolean {
	return this.localeCompare(s, undefined, {
		sensitivity: 'accent'
	}) === 0;
};