# Your own settings, from local/config.json: a clone of your private dotfiles-local repo
# (bootstrap.sh clones it). Without one, local.example.json, which documents the format.
#
#   local_config <jq filter>   prints the result, raw (empty for null or nothing)
#   local_path <path>          expands a leading ~ in a path from the config
#
# DOTFILES_LOCAL_CONFIG names another file, for trying something out with settings of its
# own (a throwaway shared browser, say).
local_config() {
  local file=${DOTFILES_LOCAL_CONFIG:-"$HOME/.dotfiles/local/config.json"}
  [[ -f $file ]] || file="$HOME/.dotfiles/local.example.json"
  jq -r "($1) // empty" "$file"
}

local_path() {
  print -r -- "${1/#\~/$HOME}"
}
