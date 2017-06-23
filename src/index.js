const SourceMapConsumer = require('source-map').SourceMapConsumer;
const { SourceMapSource, RawSource, ConcatSource } = require('webpack-sources');
const RequestShortener = require('webpack/lib/RequestShortener');
const ModuleFilenameHelpers = require('webpack/lib/ModuleFilenameHelpers');
const uglify = require('uglify-es');

class UglifyEsPlugin {
    constructor(options = {}) {
        this._options = Object.assign(true, {
            test: /\.js($|\?)/i,
            warningFilter: () => true,
            sourceMap: true,
            mangle: true,
            toplevel: false,
            comments: /^\**!|@preserve|@license/
        }, options);
    }

    apply(compiler) {
        compiler.plugin('compilation', compilation => {
            if (this._options.sourceMap) {
                compilation.plugin('build-module', module => {
                    module.useSourceMap = true;
                });
            }
            compilation.plugin(
                'optimize-chunk-assets',
                (chunks, callback) => this._compile(compilation, chunks, callback)
            );
        });
    }

    _compile(compilation, chunks, callback) {
        const files = chunks.reduce((all, chunk) => {
            all.push(...chunk.files);
            return all;
        }, [...compilation.additionalChunkAssets]);

        files
            .filter(file => ModuleFilenameHelpers.matchObject(this._options, file))
            .forEach(file => {
                const oldWarnFunction = uglify.AST_Node.warn_function;
                try {
                    this._processFile(compilation, file)
                } catch (err) {
                    this._processExeption(compilation, err, file);
                } finally {
                    uglify.AST_Node.warn_function = oldWarnFunction;
                }
            });
        callback();
    }

    _processFile(compilation, file) {
        const warnings = [];
        const asset = compilation.assets[file];
        if (asset.__UglifyJsPlugin) {
            compilation.assets[file] = asset.__UglifyJsPlugin;
            return;
        }

        // Setup output object.
        const output = Object.assign({
            comments: this._options.comments,
            beautify: this._options.beautify
        }, this._options.output);

        // Source map.
        const input = this._processSourceMap(asset);

        // Compress.
        const compressedCode = uglify.minify(input, {
            mangle: this._options.mangle,
            toplevel: this._options.toplevel,
            sourceMap: this._options.sourceMap
        }).code;

        // Extract comments.
        let extractedComments = [];
        if (this._options.extractComments) {
            extractedComments = this._processExtractComments(output);
        }

        // let map
        // Setup source map.
        // if (this._options.sourceMap) {
        //     output.source_map = map;
        // }
        const outputSource = new RawSource(compressedCode);

        // Write extracted comments to commentsFile
        if (extractedComments.length > 0) {
            this._writeExtractedComments(compilation, extractedComments);
        }
        asset.__UglifyJsPlugin = compilation.assets[file] = outputSource;

        if (warnings.length > 0) {
            compilation.warnings.push(new Error(`${file} from UglifyJs\n ${warnings.join('\n')}`));
        }
    }

    _processExtractComments(output) {
        const extractedComments = [];
        const condition = {};
        if (typeof this._options.extractComments === 'string' || this._options.extractComments instanceof RegExp) {
            // extractComments specifies the extract condition and output.comments specifies the preserve condition
            condition.preserve = output.comments;
            condition.extract = options.extractComments;
        } else if (Object.prototype.hasOwnProperty.call(options.extractComments, "condition")) {
            // Extract condition is given in extractComments.condition
            condition.preserve = output.comments;
            condition.extract = options.extractComments.condition;
        } else {
            // No extract condition is given. Extract comments that match output.comments instead of preserving them
            condition.preserve = false;
            condition.extract = output.comments;
        }

        // Ensure that both conditions are functions
        ['preserve', 'extract'].forEach(key => {
            switch(typeof condition[key]) {
                case 'boolean':
                    var b = condition[key];
                    condition[key] = () => b;
                    break;

                case 'function':
                    break;

                case 'string':
                    if(condition[key] === 'all') {
                        condition[key] = () => true;
                        break;
                    }
                    var regex = new RegExp(condition[key]);
                    condition[key] = (astNode, comment) => regex.test(comment.value);
                    break;

                default:
                    regex = condition[key];
                    condition[key] = (astNode, comment) => regex.test(comment.value);
            }
        });

        // Redefine the comments function to extract and preserve
        // comments according to the two conditions
        output.comments = (astNode, comment) => {
            if (condition.extract(astNode, comment)) {
                const comm = comment.type === 'comment2' ?
                    `/*${comment.value}*/` :
                    `//${comment.value}`;

                extractedComments.push(comm);
            }
            return condition.preserve(astNode, comment);
        };

        return extractedComments;
    }

    _processSourceMap(asset, warnings) {
        let input;
        let inputSourceMap;

        if (!this._options.sourceMap) {
            input = asset.source();
        }

        if (asset.sourceAndMap) {
            const sourceAndMap = asset.sourceAndMap();
            inputSourceMap = sourceAndMap.map;
            input = sourceAndMap.source;
        } else {
            inputSourceMap = asset.map();
            input = asset.source();
        }

        const sourceMap = new SourceMapConsumer(inputSourceMap);
        return input;
    }

    _processExeption(compilation, err, file, sourceMap) {
        if (err.line) {
            const original = sourceMap && sourceMap.originalPositionFor({
                line: err.line,
                column: err.col
            });
            if (original && original.source) {
                compilation.errors.push(new Error(file + " from UglifyJs\n" + err.message + " [" + requestShortener.shorten(original.source) + ":" + original.line + "," + original.column + "][" + file + ":" + err.line + "," + err.col + "]"));
            } else {
                compilation.errors.push(new Error(file + " from UglifyJs\n" + err.message + " [" + file + ":" + err.line + "," + err.col + "]"));
            }
        } else if (err.msg) {
            compilation.errors.push(new Error(file + " from UglifyJs\n" + err.msg));
        } else {
            compilation.errors.push(new Error(file + " from UglifyJs\n" + err.stack));
        }
    }

    _writeExtractedComments(compilation, extractedComments = []) {
        let commentsFile = this._options.extractComments.filename || `${file}.LICENSE`;
        if (typeof commentsFile === 'function') {
            commentsFile = commentsFile(file);
        }

        const commentsSource = new RawSource(extractedComments.join('\n\n') + '\n');
        if (commentsFile in compilation.assets) {
            // commentsFile already exists, append new comments...
            if (compilation.assets[commentsFile] instanceof ConcatSource) {
                compilation.assets[commentsFile].add('\n');
                compilation.assets[commentsFile].add(commentsSource);
            } else {
                compilation.assets[commentsFile] = new ConcatSource(
                    compilation.assets[commentsFile], '\n', commentsSource
                );
            }
        } else {
            compilation.assets[commentsFile] = commentsSource;
        }

        // Add a banner to the original file
        if (this._options.extractComments.banner !== false) {
            let banner = this._options.extractComments.banner || `For license information please see ${commentsFile}`;
            if (typeof banner === 'function') {
                banner = banner(commentsFile);
            }
            if (banner) {
                outputSource = new ConcatSource(`/*! ${banner} */\n"`, outputSource);
            }
        }
    }
}

module.exports = UglifyEsPlugin;
