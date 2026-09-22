import _ from "lodash";

const defaults = {
  server: { port: 3000, host: "0.0.0.0" },
  logging: { level: "info", format: "text" },
};

export function loadConfig(overrides = {}) {
  return _.merge({}, defaults, overrides);
}
