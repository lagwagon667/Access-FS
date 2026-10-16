import { ClientConfiguration } from './injection/interface';

type ConfigurationValues = Partial<Omit<ClientConfiguration, 'environment' | 'logLevel'>> & {
	environment?: Partial<ClientConfiguration['environment']>;
	logLevel?: Partial<ClientConfiguration['logLevel']>;
};

export function normalizeClientConfiguration(config: ConfigurationValues | undefined): ClientConfiguration {
	return {
		maxDocumentLines: config?.maxDocumentLines ?? 5000,
		maxNumberOfProblems: config?.maxNumberOfProblems ?? 100,
		doWarnOptionExplicitMissing: config?.doWarnOptionExplicitMissing ?? true,
		environment: {
			os: config?.environment?.os ?? 'Win64',
			version: config?.environment?.version ?? 'Vba7',
		},
		logLevel: {
			outputChannel: config?.logLevel?.outputChannel ?? 'Warn',
		},
	};
}
