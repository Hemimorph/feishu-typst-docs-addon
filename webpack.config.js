const path = require('path');
const webpack = require('webpack');
const ReactRefreshWebpackPlugin = require('@pmmmwh/react-refresh-webpack-plugin');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const { EsbuildPlugin } = require('esbuild-loader');
const MiniCssExtractPlugin = require('mini-css-extract-plugin');
const WebpackBar = require('webpackbar');
const {
  docsAddonDevMiddleware,
  docsAddonWebpackPlugin,
} = require('@lark-opdev/block-docs-addon-webpack-utils');

const isDevelopment = process.env.NODE_ENV === 'development';
const isProduction = process.env.NODE_ENV === 'production';
const defaultTypstResourceMirror = 'https://cdn.jsdelivr.net/npm';
const defaultTypstResourceMirrorMode = 'npm-cdn';

const normalizeResourceMirror = (value) => {
  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error('TYPST_RESOURCE_MIRROR must be a valid HTTPS base URL');
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('TYPST_RESOURCE_MIRROR must use HTTPS');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('TYPST_RESOURCE_MIRROR cannot contain credentials, query, or fragment');
  }
  return parsed.toString().replace(/\/+$/, '');
};

const typstResourceMirror = normalizeResourceMirror(
  process.env.TYPST_RESOURCE_MIRROR || defaultTypstResourceMirror,
);
const typstResourceMirrorMode =
  process.env.TYPST_RESOURCE_MIRROR_MODE || defaultTypstResourceMirrorMode;
if (!['npm-cdn', 'npm-registry'].includes(typstResourceMirrorMode)) {
  throw new Error('TYPST_RESOURCE_MIRROR_MODE must be npm-cdn or npm-registry');
}

module.exports = {
  entry: {
    index: './src/index.tsx',
    modal: './src/modal.tsx',
  },
  devtool: isProduction ? false : 'inline-source-map',
  mode: isDevelopment ? 'development' : 'production',
  stats: 'errors-warnings',
  output: {
    path: path.resolve(__dirname, 'dist'),
    clean: true,
    publicPath: isDevelopment ? '/block/' : './',
  },
  module: {
    rules: [
      {
        test: /\.[jt]sx?$/,
        include: path.resolve(__dirname, 'src'),
        use: {
          loader: require.resolve('esbuild-loader'),
          options: {
            loader: 'tsx',
            target: 'es2019',
          },
        },
      },
      {
        test: /\.css$/,
        use: [
          isDevelopment ? 'style-loader' : MiniCssExtractPlugin.loader,
          'css-loader',
        ],
      },
    ],
  },
  plugins: [
    new webpack.DefinePlugin({
      __TYPST_RESOURCE_MIRROR__: JSON.stringify(typstResourceMirror),
      __TYPST_RESOURCE_MIRROR_MODE__: JSON.stringify(typstResourceMirrorMode),
    }),
    ...(isDevelopment
      ? [new ReactRefreshWebpackPlugin(), new WebpackBar()]
      : [new MiniCssExtractPlugin()]),
    new docsAddonWebpackPlugin({}),
    new HtmlWebpackPlugin({
      filename: 'index.html',
      template: './src/index.html',
      chunks: ['runtime', 'vendor', 'index'],
      publicPath: isDevelopment ? '/block/' : './',
    }),
    new HtmlWebpackPlugin({
      filename: 'modal.html',
      template: './src/modal.html',
      chunks: ['runtime', 'vendor', 'modal'],
      publicPath: isDevelopment ? '/block/' : './',
    }),
  ],
  resolve: {
    extensions: ['.ts', '.tsx', '.js', '.jsx'],
  },
  optimization: {
    minimize: isProduction,
    minimizer: [new EsbuildPlugin({ target: 'es2019', css: true })],
    moduleIds: 'deterministic',
    runtimeChunk: 'single',
    splitChunks: {
      chunks: 'all',
      cacheGroups: {
        vendor: {
          name: 'vendor',
          test: /[\\/]node_modules[\\/]/,
          chunks: 'initial',
        },
      },
    },
  },
  devServer: isProduction
    ? undefined
    : {
        headers: {
          'Access-Control-Allow-Private-Network': 'true',
        },
        hot: true,
        client: {
          logging: 'error',
        },
        setupMiddlewares: (middlewares, devServer) => {
          if (!devServer || !devServer.app) {
            throw new Error('webpack-dev-server is not defined');
          }
          docsAddonDevMiddleware(devServer).then((middleware) => {
            devServer.app.use(middleware);
          });
          return middlewares;
        },
      },
  cache: {
    type: 'filesystem',
    buildDependencies: {
      config: [__filename],
    },
  },
};
