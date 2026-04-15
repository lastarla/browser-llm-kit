const path = require('node:path');
const CopyPlugin = require('copy-webpack-plugin');

const copyPatterns = [
  {
    from: path.resolve(__dirname, 'front/index.html'),
    to: path.resolve(__dirname, 'dist/front/index.html'),
  },
  {
    from: path.resolve(__dirname, 'front/styles.css'),
    to: path.resolve(__dirname, 'dist/front/styles.css'),
  },
  {
    from: path.resolve(__dirname, 'front/llm-asset-sw.js'),
    to: path.resolve(__dirname, 'dist/front/llm-asset-sw.js'),
  },
  {
    from: path.resolve(__dirname, 'node_modules/@mediapipe/tasks-genai/wasm'),
    to: path.resolve(__dirname, 'dist/front/wasm'),
    noErrorOnMissing: true,
  },
];

if (process.env.COPY_LLM_ASSETS === 'true') {
  copyPatterns.push({
    from: path.resolve(__dirname, 'front/assets'),
    to: path.resolve(__dirname, 'dist/front/assets'),
    noErrorOnMissing: true,
  });
}

module.exports = {
  mode: process.env.NODE_ENV === 'production' ? 'production' : 'development',
  entry: path.resolve(__dirname, 'front/app.js'),
  output: {
    path: path.resolve(__dirname, 'dist/front'),
    filename: 'app.js',
    clean: true,
  },
  devtool: process.env.NODE_ENV === 'production' ? false : 'source-map',
  experiments: {
    topLevelAwait: true,
  },
  module: {
    rules: [
      {
        test: /\.css$/i,
        type: 'asset/source',
      },
    ],
  },
  resolve: {
    extensions: ['.js'],
    fallback: {
      fs: false,
      path: false,
      crypto: false,
    },
  },
  plugins: [
    new CopyPlugin({
      patterns: copyPatterns,
    }),
  ],
  target: ['web', 'es2020'],
};
