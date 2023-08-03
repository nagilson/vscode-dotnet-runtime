//@ts-check

'use strict';

const path = require('path');
const CopyPlugin = require('copy-webpack-plugin');
const NodePolyfillPlugin = require("node-polyfill-webpack-plugin")
const webpack = require('webpack');

/**@type {import('webpack').Configuration}*/
const extensionConfig = {
  target: 'webworker', // vscode extensions run in webworker context for VS Code web 📖 -> https://webpack.js.org/configuration/target/#target

  entry: './src/extension.ts', // the entry point of this extension, 📖 -> https://webpack.js.org/configuration/entry-context/
  output: {
    // the bundle is stored in the 'dist' folder (check package.json), 📖 -> https://webpack.js.org/configuration/output/
    path: path.resolve(__dirname, 'dist'),
    filename: 'extension.js',
    libraryTarget: 'commonjs2',
    devtoolModuleFilenameTemplate: '../[resource-path]'
  },
  devtool: 'source-map',
  externals: {
    vscode: 'commonjs vscode' // the vscode-module is created on-the-fly and must be excluded. Add other modules that cannot be webpack'ed, 📖 -> https://webpack.js.org/configuration/externals/
  },
  resolve: {
    // support reading TypeScript and JavaScript files, 📖 -> https://github.com/TypeStrong/ts-loader
    mainFields: ['browser', 'module', 'main'], // look for `browser` entry point in imported node modules
    extensions: ['.ts', '.js'],
    alias: {
      // provides alternate implementation for node module and source files
    },
    fallback: {
      // Webpack 5 no longer polyfills Node.js core modules automatically.
      // see https://webpack.js.org/configuration/resolve/#resolvefallback
      // for the list of Node.js core module polyfills.
      "fs": false,
      "tls": false,
      "net": false,
      "path": false,
      "zlib": false,
      "http": false,
      "https": false,
      "stream": false,
      "crypto": false,
      "child_process": false,
      "ajv": false,
      "shelljs": false,
      "lodash": false,
      "sshpk": false,
      "crypto-browserify": require.resolve('crypto-browserify'), //if you want to use this module also don't forget npm i crypto-browserify
    }
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: /node_modules/,
        use: [
          {
            loader: 'ts-loader'
          }
        ]
      }
    ]
  },
  plugins: [
    new CopyPlugin({ patterns: [
      { from: path.resolve(__dirname, '../vscode-dotnet-runtime-library/install scripts'), to: path.resolve(__dirname, 'dist', 'install scripts') },
      { from: path.resolve(__dirname, '../vscode-dotnet-runtime-library/distro-data'), to: path.resolve(__dirname, 'dist', 'distro-data') },
      { from: path.resolve(__dirname, '../images'), to: path.resolve(__dirname, 'images') },
      { from: path.resolve(__dirname, '../LICENSE.txt'), to: path.resolve(__dirname, 'LICENSE.txt') },
    ]}),
      new NodePolyfillPlugin()
  ]
};

const uninstallConfig = {
  entry: './src/ExtensionUninstall.ts',
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        use: 'ts-loader',
        exclude: /node_modules/,
      },
    ],
  },
  resolve: {
    extensions: ['.ts', '.js'],
  },
  output: {
    filename: 'ExtensionUninstall.js',
    path: path.resolve(__dirname, 'dist'),
  },
  target: 'node',
};

module.exports = [
  extensionConfig,
  uninstallConfig
];