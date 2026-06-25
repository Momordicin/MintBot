module.exports = {
  apps: [
    {
      name: 'mintbot-core',
      script: 'out/core/index.js',
      interpreter: 'node',
      watch: false,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
}