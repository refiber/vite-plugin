import fs from "fs";
import { AddressInfo } from "net";
import os from "os";
import colors from "picocolors";
import path from "path";
import {
	Plugin,
	loadEnv,
	UserConfig,
	ConfigEnv,
	ResolvedConfig,
	PluginOption,
} from "vite";
import fullReload, {
	Config as FullReloadConfig,
} from "vite-plugin-full-reload";
import { fileURLToPath } from "url";

interface PluginConfig {
	/**
	 * The path or paths of the entry points to compile.
	 */
	input: string | string[];

	/**
	 * Refiber's public directory.
	 *
	 * @default 'public'
	 */
	publicDirectory?: string;

	/**
	 * The public subdirectory where compiled assets should be written.
	 *
	 * @default 'build'
	 */
	buildDirectory?: string;

	/**
	 * The path to the "hot" file.
	 *
	 * @default `${publicDirectory}/hot`
	 */
	hotFile?: string;

	/**
	 * Configuration for performing full page refresh on blade (or other) file changes.
	 *
	 * {@link https://github.com/ElMassimo/vite-plugin-full-reload}
	 * @default false
	 */
	refresh?: boolean | string | string[] | RefreshConfig | RefreshConfig[];

	/**
	 * Utilise the Herd or Valet TLS certificates.
	 *
	 * @default null
	 */
	detectTls?: string | boolean | null;

	/**
	 * Utilise the Herd or Valet TLS certificates.
	 *
	 * @default null
	 * @deprecated use "detectTls" instead
	 */
	valetTls?: string | boolean | null;

	/**
	 * Transform the code while serving.
	 */
	transformOnServe?: (code: string, url: DevServerUrl) => string;
}

interface RefreshConfig {
	paths: string[];
	config?: FullReloadConfig;
}

interface RefiberPlugin extends Plugin {
	config: (config: UserConfig, env: ConfigEnv) => UserConfig;
}

export default function refiber(
	config: string | string | PluginConfig
): [RefiberPlugin, ...Plugin[]] {
	const pluginConfig = resolvePluginConfig(config);

	return [
		resolveRefiberPlugin(pluginConfig),
		...(resolveFullReloadConfig(pluginConfig) as Plugin[]),
	];
}

type DevServerUrl = `${"http" | "https"}://${string}:${number}`;

let exitHandlersBound = false;

function resolveRefiberPlugin(
	pluginConfig: Required<PluginConfig>
): RefiberPlugin {
	let viteDevServerUrl: DevServerUrl;
	let resolvedConfig: ResolvedConfig;
	let userConfig: UserConfig;

	const defaultAliases: Record<string, string> = {
		"@": "/resources/js",
	};

	return {
		name: "Refiber",
		enforce: "post",
		config: (config, { command, mode }) => {
			userConfig = config;
			const env = loadEnv(mode, userConfig.envDir || process.cwd(), "");
			const assetUrl = env.ASSET_URL ?? "";
			const serverConfig =
				command === "serve"
					? resolveDevelopmentEnvironmentServerConfig(pluginConfig.detectTls) ??
					  resolveEnvironmentServerConfig(env)
					: undefined;

			ensureCommandShouldRunInEnvironment(command, env);

			return {
				base:
					userConfig.base ??
					(command === "build" ? resolveBase(pluginConfig, assetUrl) : ""),
				publicDir: userConfig.publicDir ?? false,
				build: {
					manifest: userConfig.build?.manifest ?? "manifest.json",
					ssrManifest: false,
					outDir: userConfig.build?.outDir ?? resolveOutDir(pluginConfig),
					rollupOptions: {
						input:
							userConfig.build?.rollupOptions?.input ??
							resolveInput(pluginConfig),
					},
					assetsInlineLimit: userConfig.build?.assetsInlineLimit ?? 0,
				},
				server: {
					origin: userConfig.server?.origin ?? "__refiber_vite_placeholder__",
					...(serverConfig
						? {
								host: userConfig.server?.host ?? serverConfig.host,
								hmr:
									userConfig.server?.hmr === false
										? false
										: {
												...serverConfig.hmr,
												...(userConfig.server?.hmr === true
													? {}
													: userConfig.server?.hmr),
										  },
								https: userConfig.server?.https ?? serverConfig.https,
						  }
						: undefined),
				},
				resolve: {
					alias: Array.isArray(userConfig.resolve?.alias)
						? [
								...(userConfig.resolve?.alias ?? []),
								...Object.keys(defaultAliases).map((alias) => ({
									find: alias,
									replacement: defaultAliases[alias],
								})),
						  ]
						: {
								...defaultAliases,
								...userConfig.resolve?.alias,
						  },
				},
			};
		},
		configResolved(config) {
			resolvedConfig = config;
		},
		transform(code) {
			if (resolvedConfig.command === "serve") {
				code = code.replace(/__refiber_vite_placeholder__/g, viteDevServerUrl);

				return pluginConfig.transformOnServe(code, viteDevServerUrl);
			}
		},
		configureServer(server) {
			const envDir = resolvedConfig.envDir || process.cwd();
			const appUrl =
				loadEnv(resolvedConfig.mode, envDir, "APP_URL").APP_URL ?? "undefined";

			server.httpServer?.once("listening", () => {
				const address = server.httpServer?.address();

				const isAddressInfo = (
					x: string | AddressInfo | null | undefined
				): x is AddressInfo => typeof x === "object";
				if (isAddressInfo(address)) {
					viteDevServerUrl = userConfig.server?.origin
						? (userConfig.server.origin as DevServerUrl)
						: resolveDevServerUrl(address, server.config, userConfig);
					fs.writeFileSync(pluginConfig.hotFile, viteDevServerUrl);

					// TODO: add refiber version
					setTimeout(() => {
						server.config.logger.info(
							`\n  ${colors.red(
								`${colors.bold("FIBER")} ${fiberVersion()}`
							)}  ${colors.dim("plugin")} ${colors.bold(`v${pluginVersion()}`)}`
						);
						server.config.logger.info("");
						server.config.logger.info(
							`  ${colors.green("➜")}  ${colors.bold("APP_URL")}: ${colors.cyan(
								appUrl.replace(/:(\d+)/, (_, port) => `:${colors.bold(port)}`)
							)}`
						);

						if (
							typeof resolvedConfig.server.https === "object" &&
							typeof resolvedConfig.server.https.key === "string"
						) {
							if (
								resolvedConfig.server.https.key.startsWith(herdConfigPath())
							) {
								server.config.logger.info(
									`  ${colors.green(
										"➜"
									)}  Using Herd certificate to secure Vite.`
								);
							}

							if (
								resolvedConfig.server.https.key.startsWith(valetConfigPath())
							) {
								server.config.logger.info(
									`  ${colors.green(
										"➜"
									)}  Using Valet certificate to secure Vite.`
								);
							}
						}
					}, 100);
				}
			});

			if (!exitHandlersBound) {
				const clean = () => {
					if (fs.existsSync(pluginConfig.hotFile)) {
						fs.rmSync(pluginConfig.hotFile);
					}
				};

				process.on("exit", clean);
				process.on("SIGINT", () => process.exit());
				process.on("SIGTERM", () => process.exit());
				process.on("SIGHUP", () => process.exit());

				exitHandlersBound = true;
			}

			return () =>
				server.middlewares.use((req, res, next) => {
					if (req.url === "/index.html") {
						res.statusCode = 404;

						res.end(
							fs
								.readFileSync(path.join(dirname(), "dev-server-index.html"))
								.toString()
								.replace(/{{ APP_URL }}/g, appUrl)
						);
					}

					next();
				});
		},
	};
}

function resolveFullReloadConfig({
	refresh: config,
}: Required<PluginConfig>): PluginOption[] {
	if (typeof config === "boolean") {
		return [];
	}

	if (typeof config === "string") {
		config = [{ paths: [config] }];
	}

	if (!Array.isArray(config)) {
		config = [config];
	}

	if (config.some((c) => typeof c === "string")) {
		config = [{ paths: config }] as RefreshConfig[];
	}

	return (config as RefreshConfig[]).flatMap((c) => {
		const plugin = fullReload(c.paths, c.config);

		/* eslint-disable-next-line @typescript-eslint/ban-ts-comment */
		/** @ts-ignore */
		plugin.__refiber_plugin_config = c;

		return plugin;
	});
}

/**
 * Resolve the dev server URL from the server address and configuration.
 */
function resolveDevServerUrl(
	address: AddressInfo,
	config: ResolvedConfig,
	userConfig: UserConfig
): DevServerUrl {
	const configHmrProtocol =
		typeof config.server.hmr === "object" ? config.server.hmr.protocol : null;
	const clientProtocol = configHmrProtocol
		? configHmrProtocol === "wss"
			? "https"
			: "http"
		: null;
	const serverProtocol = config.server.https ? "https" : "http";
	const protocol = clientProtocol ?? serverProtocol;

	const configHmrHost =
		typeof config.server.hmr === "object" ? config.server.hmr.host : null;
	const configHost =
		typeof config.server.host === "string" ? config.server.host : null;
	const sailHost =
		process.env.LARAVEL_SAIL && !userConfig.server?.host ? "localhost" : null;
	const serverAddress = isIpv6(address)
		? `[${address.address}]`
		: address.address;
	const host = configHmrHost ?? sailHost ?? configHost ?? serverAddress;

	const configHmrClientPort =
		typeof config.server.hmr === "object" ? config.server.hmr.clientPort : null;
	const port = configHmrClientPort ?? address.port;

	return `${protocol}://${host}:${port}`;
}

function isIpv6(address: AddressInfo): boolean {
	return (
		address.family === "IPv6" ||
		// In node >=18.0 <18.4 this was an integer value. This was changed in a minor version.
		// See: https://github.com/laravel/vite-plugin/issues/103
		// eslint-disable-next-line @typescript-eslint/ban-ts-comment
		// @ts-ignore-next-line
		address.family === 6
	);
}

/**
 * The version of the Refiber Vite plugin being run.
 */
function pluginVersion(): string {
	try {
		return JSON.parse(
			fs.readFileSync(path.join(dirname(), "../package.json")).toString()
		)?.version;
	} catch {
		return "";
	}
}

/**
 * The version of fiber being run.
 */
function fiberVersion(): string {
	try {
		const goMOD = fs.readFileSync("go.mod").toString();
		const v = goMOD.match(/github.com\/gofiber\/fiber\/v..(.*)/i);

		return v?.[1] || "";
	} catch {
		return "";
	}
}

/**
 * Resolve the Vite base option from the configuration.
 */
function resolveBase(config: Required<PluginConfig>, assetUrl: string): string {
	return (
		assetUrl +
		(!assetUrl.endsWith("/") ? "/" : "") +
		config.buildDirectory +
		"/"
	);
}

/**
 * Resolve the Vite input path from the configuration.
 */
function resolveInput(
	config: Required<PluginConfig>
): string | string[] | undefined {
	return config.input;
}

/**
 * Resolve the Vite outDir path from the configuration.
 */
function resolveOutDir(config: Required<PluginConfig>): string | undefined {
	return path.join(config.publicDirectory, config.buildDirectory);
}

/**
 * Validate the command can run in the given environment.
 */
function ensureCommandShouldRunInEnvironment(
	command: "build" | "serve",
	env: Record<string, string>
): void {
	if (command === "build" || env.LARAVEL_BYPASS_ENV_CHECK === "1") {
		return;
	}
}

export const refreshPaths = ["resources/views/**", "routes/**"].filter((path) =>
	fs.existsSync(path.replace(/\*\*$/, ""))
);

/**
 * Resolve the server config from the environment.
 */
function resolveEnvironmentServerConfig(env: Record<string, string>):
	| {
			hmr?: { host: string };
			host?: string;
			https?: { cert: Buffer; key: Buffer };
	  }
	| undefined {
	if (!env.VITE_DEV_SERVER_KEY && !env.VITE_DEV_SERVER_CERT) {
		return;
	}

	if (
		!fs.existsSync(env.VITE_DEV_SERVER_KEY) ||
		!fs.existsSync(env.VITE_DEV_SERVER_CERT)
	) {
		throw Error(
			`Unable to find the certificate files specified in your environment. Ensure you have correctly configured VITE_DEV_SERVER_KEY: [${env.VITE_DEV_SERVER_KEY}] and VITE_DEV_SERVER_CERT: [${env.VITE_DEV_SERVER_CERT}].`
		);
	}

	const host = resolveHostFromEnv(env);

	if (!host) {
		throw Error(
			`Unable to determine the host from the environment's APP_URL: [${env.APP_URL}].`
		);
	}

	return {
		hmr: { host },
		host,
		https: {
			key: fs.readFileSync(env.VITE_DEV_SERVER_KEY),
			cert: fs.readFileSync(env.VITE_DEV_SERVER_CERT),
		},
	};
}

/**
 * Resolve the host name from the environment.
 */
function resolveHostFromEnv(env: Record<string, string>): string | undefined {
	try {
		return new URL(env.APP_URL).host;
	} catch {
		return;
	}
}

/**
 * Convert the users configuration into a standard structure with defaults.
 */
function resolvePluginConfig(
	config: string | string[] | PluginConfig
): Required<PluginConfig> {
	if (typeof config === "undefined") {
		throw new Error("laravel-vite-plugin: missing configuration.");
	}

	if (typeof config === "string" || Array.isArray(config)) {
		config = { input: config };
	}

	if (typeof config.input === "undefined") {
		throw new Error('laravel-vite-plugin: missing configuration for "input".');
	}

	if (typeof config.publicDirectory === "string") {
		config.publicDirectory = config.publicDirectory.trim().replace(/^\/+/, "");

		if (config.publicDirectory === "") {
			throw new Error(
				"laravel-vite-plugin: publicDirectory must be a subdirectory. E.g. 'public'."
			);
		}
	}

	if (typeof config.buildDirectory === "string") {
		config.buildDirectory = config.buildDirectory
			.trim()
			.replace(/^\/+/, "")
			.replace(/\/+$/, "");

		if (config.buildDirectory === "") {
			throw new Error(
				"laravel-vite-plugin: buildDirectory must be a subdirectory. E.g. 'build'."
			);
		}
	}

	if (config.refresh === true) {
		config.refresh = [{ paths: refreshPaths }];
	}

	return {
		input: config.input,
		publicDirectory: config.publicDirectory ?? "public",
		buildDirectory: config.buildDirectory ?? "build",
		refresh: config.refresh ?? false,
		hotFile:
			config.hotFile ?? path.join(config.publicDirectory ?? "public", "hot"),
		valetTls: config.valetTls ?? null,
		detectTls: config.detectTls ?? config.valetTls ?? null,
		transformOnServe: config.transformOnServe ?? ((code) => code),
	};
}

/**
 * Resolve the Herd or Valet server config for the given host.
 */
function resolveDevelopmentEnvironmentServerConfig(
	host: string | boolean | null
):
	| {
			hmr?: { host: string };
			host?: string;
			https?: { cert: string; key: string };
	  }
	| undefined {
	if (host === false) {
		return;
	}

	const configPath = determineDevelopmentEnvironmentConfigPath();

	if (typeof configPath === "undefined" && host === null) {
		return;
	}

	if (typeof configPath === "undefined") {
		throw Error(
			`Unable to find the Herd or Valet configuration directory. Please check they are correctly installed.`
		);
	}

	const resolvedHost =
		host === true || host === null
			? path.basename(process.cwd()) +
			  "." +
			  resolveDevelopmentEnvironmentTld(configPath)
			: host;

	const keyPath = path.resolve(
		configPath,
		"Certificates",
		`${resolvedHost}.key`
	);
	const certPath = path.resolve(
		configPath,
		"Certificates",
		`${resolvedHost}.crt`
	);

	if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
		if (host === null) {
			return;
		}

		if (configPath === herdConfigPath()) {
			throw Error(
				`Unable to find certificate files for your host [${resolvedHost}] in the [${configPath}/Certificates] directory. Ensure you have secured the site via the Herd UI.`
			);
		} else if (typeof host === "string") {
			throw Error(
				`Unable to find certificate files for your host [${resolvedHost}] in the [${configPath}/Certificates] directory. Ensure you have secured the site by running \`valet secure ${host}\`.`
			);
		} else {
			throw Error(
				`Unable to find certificate files for your host [${resolvedHost}] in the [${configPath}/Certificates] directory. Ensure you have secured the site by running \`valet secure\`.`
			);
		}
	}

	return {
		hmr: { host: resolvedHost },
		host: resolvedHost,
		https: {
			key: keyPath,
			cert: certPath,
		},
	};
}

/**
 * Resolve the TLD via the config path.
 */
function resolveDevelopmentEnvironmentTld(configPath: string): string {
	const configFile = path.resolve(configPath, "config.json");

	if (!fs.existsSync(configFile)) {
		throw Error(`Unable to find the configuration file [${configFile}].`);
	}

	const config: { tld: string } = JSON.parse(
		fs.readFileSync(configFile, "utf-8")
	);

	return config.tld;
}

/**
 * Resolve the path to the Herd or Valet configuration directory.
 */
function determineDevelopmentEnvironmentConfigPath(): string | undefined {
	if (fs.existsSync(herdConfigPath())) {
		return herdConfigPath();
	}

	if (fs.existsSync(valetConfigPath())) {
		return valetConfigPath();
	}
}

/**
 * The directory of the current file.
 */
function dirname(): string {
	return fileURLToPath(new URL(".", import.meta.url));
}

/**
 * Herd's configuration directory.
 */
function herdConfigPath(): string {
	return path.resolve(
		os.homedir(),
		"Library",
		"Application Support",
		"Herd",
		"config",
		"valet"
	);
}

/**
 * Valet's configuration directory.
 */
function valetConfigPath(): string {
	return path.resolve(os.homedir(), ".config", "valet");
}
