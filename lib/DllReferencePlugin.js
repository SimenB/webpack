/*
	MIT License http://www.opensource.org/licenses/mit-license.php
	Author Tobias Koppers @sokra
*/

"use strict";

const parseJson = require("json-parse-even-better-errors");
const DelegatedModuleFactoryPlugin = require("./DelegatedModuleFactoryPlugin");
const ExternalModuleFactoryPlugin = require("./ExternalModuleFactoryPlugin");
const WebpackError = require("./WebpackError");
const DelegatedSourceDependency = require("./dependencies/DelegatedSourceDependency");
const createSchemaValidation = require("./util/create-schema-validation");
const makePathsRelative = require("./util/identifier").makePathsRelative;

/** @typedef {import("../declarations/WebpackOptions").Externals} Externals */
/** @typedef {import("../declarations/plugins/DllReferencePlugin").DllReferencePluginOptions} DllReferencePluginOptions */
/** @typedef {import("../declarations/plugins/DllReferencePlugin").DllReferencePluginOptionsManifest} DllReferencePluginOptionsManifest */
/** @typedef {import("./Compiler")} Compiler */
/** @typedef {import("./util/fs").InputFileSystem} InputFileSystem */

const validate = createSchemaValidation(
	require("../schemas/plugins/DllReferencePlugin.check.js"),
	() => require("../schemas/plugins/DllReferencePlugin.json"),
	{
		name: "Dll Reference Plugin",
		baseDataPath: "options"
	}
);

class DllReferencePlugin {
	/**
	 * @param {DllReferencePluginOptions} options options object
	 */
	constructor(options) {
		validate(options);
		this.options = options;
		/** @type {WeakMap<object, {path: string, data: DllReferencePluginOptionsManifest?, error: Error?}>} */
		this._compilationData = new WeakMap();
	}

	/**
	 * Apply the plugin
	 * @param {Compiler} compiler the compiler instance
	 * @returns {void}
	 */
	apply(compiler) {
		compiler.hooks.compilation.tap(
			"DllReferencePlugin",
			(compilation, { normalModuleFactory }) => {
				compilation.dependencyFactories.set(
					DelegatedSourceDependency,
					normalModuleFactory
				);
			}
		);

		compiler.hooks.beforeCompile.tapAsync(
			"DllReferencePlugin",
			(params, callback) => {
				if ("manifest" in this.options) {
					const manifest = this.options.manifest;
					if (typeof manifest === "string") {
						/** @type {InputFileSystem} */
						(compiler.inputFileSystem).readFile(manifest, (err, result) => {
							if (err) return callback(err);
							const data = {
								path: manifest,
								data: undefined,
								error: undefined
							};
							// Catch errors parsing the manifest so that blank
							// or malformed manifest files don't kill the process.
							try {
								data.data = parseJson(
									/** @type {Buffer} */ (result).toString("utf-8")
								);
							} catch (parseErr) {
								// Store the error in the params so that it can
								// be added as a compilation error later on.
								const manifestPath = makePathsRelative(
									compiler.options.context,
									manifest,
									compiler.root
								);
								data.error = new DllManifestError(
									manifestPath,
									parseErr.message
								);
							}
							this._compilationData.set(params, data);
							return callback();
						});
						return;
					}
				}
				return callback();
			}
		);

		compiler.hooks.compile.tap("DllReferencePlugin", params => {
			let name = this.options.name;
			let sourceType = this.options.sourceType;
			let content =
				"content" in this.options ? this.options.content : undefined;
			if ("manifest" in this.options) {
				const manifestParameter = this.options.manifest;
				let manifest;
				if (typeof manifestParameter === "string") {
					const data = this._compilationData.get(params);
					// If there was an error parsing the manifest
					// file, exit now because the error will be added
					// as a compilation error in the "compilation" hook.
					if (data.error) {
						return;
					}
					manifest = data.data;
				} else {
					manifest = manifestParameter;
				}
				if (manifest) {
					if (!name) name = manifest.name;
					if (!sourceType) sourceType = manifest.type;
					if (!content) content = manifest.content;
				}
			}
			/** @type {Externals} */
			const externals = {};
			const source = `dll-reference ${name}`;
			externals[source] = name;
			const normalModuleFactory = params.normalModuleFactory;
			new ExternalModuleFactoryPlugin(sourceType || "var", externals).apply(
				normalModuleFactory
			);
			new DelegatedModuleFactoryPlugin({
				source,
				type: this.options.type,
				scope: this.options.scope,
				context: this.options.context || compiler.options.context,
				content,
				extensions: this.options.extensions,
				associatedObjectForCache: compiler.root
			}).apply(normalModuleFactory);
		});

		compiler.hooks.compilation.tap(
			"DllReferencePlugin",
			(compilation, params) => {
				if ("manifest" in this.options) {
					const manifest = this.options.manifest;
					if (typeof manifest === "string") {
						const data = this._compilationData.get(params);
						// If there was an error parsing the manifest file, add the
						// error as a compilation error to make the compilation fail.
						if (data.error) {
							compilation.errors.push(
								/** @type {DllManifestError} */ (data.error)
							);
						}
						compilation.fileDependencies.add(manifest);
					}
				}
			}
		);
	}
}

class DllManifestError extends WebpackError {
	/**
	 * @param {string} filename filename of the manifest
	 * @param {string} message error message
	 */
	constructor(filename, message) {
		super();

		this.name = "DllManifestError";
		this.message = `Dll manifest ${filename}\n${message}`;
	}
}

module.exports = DllReferencePlugin;
