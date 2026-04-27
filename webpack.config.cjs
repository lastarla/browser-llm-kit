const path = require('node:path');
const CopyPlugin = require('copy-webpack-plugin');

const copyPatterns = [
  {
    from: path.resolve(__dirname, 'examples/meeting-notes-demo/web/index.html'),
    to: path.resolve(__dirname, 'dist/examples/meeting-notes-demo/web/index.html'),
  },
  {
    from: path.resolve(__dirname, 'examples/meeting-notes-demo/web/sdk-host.html'),
    to: path.resolve(__dirname, 'dist/examples/meeting-notes-demo/web/sdk-host.html'),
  },
  {
    from: path.resolve(__dirname, 'examples/meeting-notes-demo/web/styles.css'),
    to: path.resolve(__dirname, 'dist/examples/meeting-notes-demo/web/styles.css'),
  },
  {
    from: path.resolve(__dirname, 'node_modules/@mediapipe/tasks-genai/wasm'),
    to: path.resolve(__dirname, 'dist/examples/meeting-notes-demo/web/wasm'),
    noErrorOnMissing: true,
  },
];

if (process.env.COPY_LLM_ASSETS === 'true') {
  copyPatterns.push({
    from: path.resolve(__dirname, 'examples/meeting-notes-demo/web/assets'),
    to: path.resolve(__dirname, 'dist/examples/meeting-notes-demo/web/assets'),
    noErrorOnMissing: true,
  });
}

module.exports = {
  mode: process.env.NODE_ENV === 'production' ? 'production' : 'development',
  entry: {
    app: path.resolve(__dirname, 'examples/meeting-notes-demo/web/app.js'),
    'sdk-host': path.resolve(__dirname, 'examples/meeting-notes-demo/web/sdk-host.js'),
  },
  output: {
    path: path.resolve(__dirname, 'dist/examples/meeting-notes-demo/web'),
    filename: '[name].js',
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
