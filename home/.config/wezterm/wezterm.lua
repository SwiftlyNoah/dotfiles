local wezterm = require("wezterm")
local config = wezterm.config_builder()

config.color_scheme = "rose-pine-moon"
config.font = wezterm.font("Hack Nerd Font")
config.font_size = 15.0
config.window_background_opacity = 0.8
config.macos_window_background_blur = 50
config.hide_tab_bar_if_only_one_tab = true
config.window_decorations = "RESIZE"

-- Which editor a clicked file opens in. Both `code` and `cursor` take
-- `--goto file:line:col`, so switching is a one-word change.
local EDITOR = "/opt/homebrew/bin/code"

config.hyperlink_rules = wezterm.default_hyperlink_rules()

-- Absolute paths: /Users/me/thing.ts, optionally :line or :line:col
table.insert(config.hyperlink_rules, {
  regex = [[(?:^|[\s"'`(\[])(/[^\s"'`)\]]+\.[A-Za-z0-9_]+(?::\d+)?(?::\d+)?)]],
  format = "openfile:$1",
  highlight = 1,
})

-- Repo-relative paths: lib/api/requestAPI.ts:142
table.insert(config.hyperlink_rules, {
  regex = [[(?:^|[\s"'`(\[])([\w.\-]+(?:/[\w.\-]+)+\.[A-Za-z0-9_]+(?::\d+)?(?::\d+)?)]],
  format = "openfile:$1",
  highlight = 1,
})

wezterm.on("open-uri", function(window, pane, uri)
  local target = uri:match("^openfile:(.+)$")
  if not target then return true end

  local path, line = target:match("^(.-):(%d+)")
  path = path or target

  if not path:match("^/") then
    local cwd = pane:get_current_working_dir()
    if cwd then
      local dir = type(cwd) == "userdata" and cwd.file_path
        or (tostring(cwd):gsub("^file://[^/]*", ""))
      if dir then path = dir:gsub("/$", "") .. "/" .. path end
    end
  end

  wezterm.background_child_process({
    EDITOR, "--goto", line and (path .. ":" .. line) or path,
  })
  return false
end)

return config
