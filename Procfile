web: bash -lc 'envsubst < config.yml.tpl > config.yml && head -n20 config.yml && node server'
postdeploy: bash -lc 'envsubst < config.yml.tpl > config.yml && node server db migrate'

