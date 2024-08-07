/*
	MIT License http://www.opensource.org/licenses/mit-license.php
	Author Tobias Koppers @sokra
*/

"use strict";

const LazySet = require("../util/LazySet");
const makeSerializable = require("../util/makeSerializable");

/** @typedef {import("enhanced-resolve").Resolver} Resolver */
/** @typedef {import("../CacheFacade").ItemCacheFacade} ItemCacheFacade */
/** @typedef {import("../Compiler")} Compiler */
/** @typedef {import("../FileSystemInfo")} FileSystemInfo */
/** @typedef {import("../FileSystemInfo").Snapshot} Snapshot */

class CacheEntry {
	constructor(result, snapshot) {
		this.result = result;
		this.snapshot = snapshot;
	}

	serialize({ write }) {
		write(this.result);
		write(this.snapshot);
	}

	deserialize({ read }) {
		this.result = read();
		this.snapshot = read();
	}
}

makeSerializable(CacheEntry, "webpack/lib/cache/ResolverCachePlugin");

/**
 * @template T
 * @param {Set<T> | LazySet<T>} set set to add items to
 * @param {Set<T> | LazySet<T>} otherSet set to add items from
 * @returns {void}
 */
const addAllToSet = (set, otherSet) => {
	if (set instanceof LazySet) {
		set.addAll(otherSet);
	} else {
		for (const item of otherSet) {
			set.add(item);
		}
	}
};

/**
 * @param {object} object an object
 * @param {boolean} excludeContext if true, context is not included in string
 * @returns {string} stringified version
 */
const objectToString = (object, excludeContext) => {
	let str = "";
	for (const key in object) {
		if (excludeContext && key === "context") continue;
		const value = object[key];
		str +=
			typeof value === "object" && value !== null
				? `|${key}=[${objectToString(value, false)}|]`
				: `|${key}=|${value}`;
	}
	return str;
};

class ResolverCachePlugin {
	/**
	 * Apply the plugin
	 * @param {Compiler} compiler the compiler instance
	 * @returns {void}
	 */
	apply(compiler) {
		const cache = compiler.getCache("ResolverCachePlugin");
		/** @type {FileSystemInfo} */
		let fileSystemInfo;
		let snapshotOptions;
		let realResolves = 0;
		let cachedResolves = 0;
		let cacheInvalidResolves = 0;
		let concurrentResolves = 0;
		compiler.hooks.thisCompilation.tap("ResolverCachePlugin", compilation => {
			snapshotOptions = compilation.options.snapshot.resolve;
			fileSystemInfo = compilation.fileSystemInfo;
			compilation.hooks.finishModules.tap("ResolverCachePlugin", () => {
				if (realResolves + cachedResolves > 0) {
					const logger = compilation.getLogger("webpack.ResolverCachePlugin");
					logger.log(
						`${Math.round(
							(100 * realResolves) / (realResolves + cachedResolves)
						)}% really resolved (${realResolves} real resolves with ${cacheInvalidResolves} cached but invalid, ${cachedResolves} cached valid, ${concurrentResolves} concurrent)`
					);
					realResolves = 0;
					cachedResolves = 0;
					cacheInvalidResolves = 0;
					concurrentResolves = 0;
				}
			});
		});
		/**
		 * @param {ItemCacheFacade} itemCache cache
		 * @param {Resolver} resolver the resolver
		 * @param {object} resolveContext context for resolving meta info
		 * @param {object} request the request info object
		 * @param {function((Error | null)=, object=): void} callback callback function
		 * @returns {void}
		 */
		const doRealResolve = (
			itemCache,
			resolver,
			resolveContext,
			request,
			callback
		) => {
			realResolves++;
			const newRequest = {
				_ResolverCachePluginCacheMiss: true,
				...request
			};
			const newResolveContext = {
				...resolveContext,
				stack: new Set(),
				/** @type {LazySet<string>} */
				missingDependencies: new LazySet(),
				/** @type {LazySet<string>} */
				fileDependencies: new LazySet(),
				/** @type {LazySet<string>} */
				contextDependencies: new LazySet()
			};
			let yieldResult;
			let withYield = false;
			if (typeof newResolveContext.yield === "function") {
				yieldResult = [];
				withYield = true;
				newResolveContext.yield = obj => yieldResult.push(obj);
			}
			const propagate = key => {
				if (resolveContext[key]) {
					addAllToSet(resolveContext[key], newResolveContext[key]);
				}
			};
			const resolveTime = Date.now();
			resolver.doResolve(
				resolver.hooks.resolve,
				newRequest,
				"Cache miss",
				newResolveContext,
				(err, result) => {
					propagate("fileDependencies");
					propagate("contextDependencies");
					propagate("missingDependencies");
					if (err) return callback(err);
					const fileDependencies = newResolveContext.fileDependencies;
					const contextDependencies = newResolveContext.contextDependencies;
					const missingDependencies = newResolveContext.missingDependencies;
					fileSystemInfo.createSnapshot(
						resolveTime,
						fileDependencies,
						contextDependencies,
						missingDependencies,
						snapshotOptions,
						(err, snapshot) => {
							if (err) return callback(err);
							const resolveResult = withYield ? yieldResult : result;
							// since we intercept resolve hook
							// we still can get result in callback
							if (withYield && result) yieldResult.push(result);
							if (!snapshot) {
								if (resolveResult) return callback(null, resolveResult);
								return callback();
							}
							itemCache.store(
								new CacheEntry(resolveResult, snapshot),
								storeErr => {
									if (storeErr) return callback(storeErr);
									if (resolveResult) return callback(null, resolveResult);
									callback();
								}
							);
						}
					);
				}
			);
		};
		compiler.resolverFactory.hooks.resolver.intercept({
			factory(type, hook) {
				/** @type {Map<string, (function(Error=, object=): void)[]>} */
				const activeRequests = new Map();
				/** @type {Map<string, [function(Error=, object=): void, function(Error=, object=): void][]>} */
				const activeRequestsWithYield = new Map();
				hook.tap(
					"ResolverCachePlugin",
					/**
					 * @param {Resolver} resolver the resolver
					 * @param {object} options resolve options
					 * @param {object} userOptions resolve options passed by the user
					 * @returns {void}
					 */
					(resolver, options, userOptions) => {
						if (options.cache !== true) return;
						const optionsIdent = objectToString(userOptions, false);
						const cacheWithContext =
							options.cacheWithContext !== undefined
								? options.cacheWithContext
								: false;
						resolver.hooks.resolve.tapAsync(
							{
								name: "ResolverCachePlugin",
								stage: -100
							},
							(request, resolveContext, callback) => {
								if (
									/** @type {TODO} */ (request)._ResolverCachePluginCacheMiss ||
									!fileSystemInfo
								) {
									return callback();
								}
								const withYield = typeof resolveContext.yield === "function";
								const identifier = `${type}${
									withYield ? "|yield" : "|default"
								}${optionsIdent}${objectToString(request, !cacheWithContext)}`;

								if (withYield) {
									const activeRequest = activeRequestsWithYield.get(identifier);
									if (activeRequest) {
										activeRequest[0].push(callback);
										activeRequest[1].push(
											/** @type {TODO} */ (resolveContext.yield)
										);
										return;
									}
								} else {
									const activeRequest = activeRequests.get(identifier);
									if (activeRequest) {
										activeRequest.push(callback);
										return;
									}
								}
								const itemCache = cache.getItemCache(identifier, null);
								let callbacks;
								let yields;
								const done = withYield
									? (err, result) => {
											if (callbacks === undefined) {
												if (err) {
													callback(err);
												} else {
													if (result)
														for (const r of result) resolveContext.yield(r);
													callback(null, null);
												}
												yields = undefined;
												callbacks = false;
											} else {
												if (err) {
													for (const cb of callbacks) cb(err);
												} else {
													for (let i = 0; i < callbacks.length; i++) {
														const cb = callbacks[i];
														const yield_ = yields[i];
														if (result) for (const r of result) yield_(r);
														cb(null, null);
													}
												}
												activeRequestsWithYield.delete(identifier);
												yields = undefined;
												callbacks = false;
											}
										}
									: (err, result) => {
											if (callbacks === undefined) {
												callback(err, result);
												callbacks = false;
											} else {
												for (const callback of callbacks) {
													callback(err, result);
												}
												activeRequests.delete(identifier);
												callbacks = false;
											}
										};
								/**
								 * @param {Error=} err error if any
								 * @param {CacheEntry=} cacheEntry cache entry
								 * @returns {void}
								 */
								const processCacheResult = (err, cacheEntry) => {
									if (err) return done(err);

									if (cacheEntry) {
										const { snapshot, result } = cacheEntry;
										fileSystemInfo.checkSnapshotValid(
											snapshot,
											(err, valid) => {
												if (err || !valid) {
													cacheInvalidResolves++;
													return doRealResolve(
														itemCache,
														resolver,
														resolveContext,
														request,
														done
													);
												}
												cachedResolves++;
												if (resolveContext.missingDependencies) {
													addAllToSet(
														/** @type {LazySet<string>} */
														(resolveContext.missingDependencies),
														snapshot.getMissingIterable()
													);
												}
												if (resolveContext.fileDependencies) {
													addAllToSet(
														/** @type {LazySet<string>} */
														(resolveContext.fileDependencies),
														snapshot.getFileIterable()
													);
												}
												if (resolveContext.contextDependencies) {
													addAllToSet(
														/** @type {LazySet<string>} */
														(resolveContext.contextDependencies),
														snapshot.getContextIterable()
													);
												}
												done(null, result);
											}
										);
									} else {
										doRealResolve(
											itemCache,
											resolver,
											resolveContext,
											request,
											done
										);
									}
								};
								itemCache.get(processCacheResult);
								if (withYield && callbacks === undefined) {
									callbacks = [callback];
									yields = [resolveContext.yield];
									activeRequestsWithYield.set(
										identifier,
										/** @type {[any, any]} */ ([callbacks, yields])
									);
								} else if (callbacks === undefined) {
									callbacks = [callback];
									activeRequests.set(identifier, callbacks);
								}
							}
						);
					}
				);
				return hook;
			}
		});
	}
}

module.exports = ResolverCachePlugin;
