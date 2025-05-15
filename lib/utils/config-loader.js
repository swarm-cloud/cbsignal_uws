const path = require('path');
const YAML = require('yamljs');
const _ = require('lodash');

class ConfigLoader {
    constructor() {
        this.config = {};
    }

    loadFromYaml(filePath) {
        try {
            const yamlConfig = YAML.load(path.resolve(filePath));
            this.config = _.merge(this.config, yamlConfig);
        } catch (e) {
            console.warn(`Failed to load YAML config from ${filePath}:`, e.message);
        }
        return this;
    }

    loadFromEnv(prefix = '') {
        const envConfig = {};

        Object.keys(process.env).forEach(envName => {
            if (envName.startsWith(prefix)) {
                const configPath = envName
                    .slice(prefix.length)
                    .toLowerCase()
                    .split('_')
                    .filter(part => part)
                    .join('.');

                const envValue = process.env[envName];
                let parsedValue = envValue;

                if (/^\d+$/.test(envValue)) {
                    parsedValue = parseInt(envValue, 10);
                } else if (envValue.toLowerCase() === 'true') {
                    parsedValue = true;
                } else if (envValue.toLowerCase() === 'false') {
                    parsedValue = false;
                }

                _.set(envConfig, configPath, parsedValue);
            }
        });

        this.config = _.merge(this.config, envConfig);
        return this;
    }

    get(key, defaultValue) {
        return _.get(this.config, key, defaultValue);
    }
}

module.exports = ConfigLoader
