const path = require('path');
var webpack = require('webpack');
const root = (dir) => {
	return path.resolve(__dirname, dir);
};

module.exports = (options) => {
	return {
		mode: 'development',
		target: 'web',
		entry: {
			'main': './src/main.ts'
		},
		resolve: {
			extensions: [".webpack.js", ".web.js", ".mjs", ".ts", ".js", ".json"],
			modules: [root('node_modules'), root('src')]
		},
		watch: true,
		devServer: {
			watchContentBase: true,
			contentBase: root('dist'),
			port: 9000
		},
		module: {
			rules: [
				{
					test: /\.mjs$/,
					include: /node_modules/,
					type: "javascript/auto",
				},
				{
				test: /\.ts$/,
				use: [{
					loader: 'awesome-typescript-loader',
					options: {
						useCache: false
					}
				}],
				exclude: [/\.(spec|e2e)\.ts$/]
			}]
		},
		output: {
			path: root('dist'),
			filename: 'index.js',
			libraryTarget: 'umd',
			sourceMapFilename: '[file].map'
		}
	};
};
