import { fileURLToPath, pathToFileURL } from 'url';

function hasUriScheme(value: string): boolean {
	return /^[a-z][a-z\d+.-]*:/i.test(value) && !/^[a-z]:[\\/]/i.test(value);
}

export function toFilePath(uriOrPath: string): string {
	return /^file:/i.test(uriOrPath) ? fileURLToPath(uriOrPath) : uriOrPath;
}

export function toFileUri(uriOrPath: string): string {
	return hasUriScheme(uriOrPath) ? uriOrPath : pathToFileURL(uriOrPath).href;
}
