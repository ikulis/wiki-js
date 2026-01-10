web: bash -lc 'envsubst < config.yml.tpl > config.yml && node server'
postdeploy: bash -lc 'envsubst < config.yml.tpl > config.yml && cat config.yml && sleep 3 && node server db migrate'

