module.exports = {
  name: "config-sync",
  script: "src/server.ts",
  interpreter: "bun",
  cwd: __dirname,
  env: { PATH: `${process.env.HOME}/.bun/bin:${process.env.PATH}` },
  autorestart: true,
  max_restarts: 10,
  kill_timeout: 5000,
};
