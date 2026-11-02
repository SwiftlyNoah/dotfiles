-- App hotkeys. Each opens or focuses its app, and when that app is already in front,
-- moves to its next window: ⌘⇧A again and again steps through Chrome's windows.
-- ⌘⇧Space stays unbound: macOS keeps it for the Screenshot app's visual intelligence.
--
-- Your own parts come from the local config (home/lib/local-config.zsh): the shared
-- browsers, and "chromeProfiles", a ⌘⇧ key for each Chrome profile of yours (one on A
-- takes ⌘⇧A for that profile's windows only).

-- First, so the `hs` command line tool (inside Hammerspoon.app) works even if a later line fails.
require("hs.ipc")

local apps = {
  D = "com.apple.MobileSMS", -- Messages
  X = "com.apple.dt.Xcode",
  C = "com.anthropic.claudefordesktop", -- the Claude desktop app
}
local HOME = os.getenv("HOME")
local localConfig = hs.json.read(HOME .. "/.dotfiles/local/config.json")
  or hs.json.read(HOME .. "/.dotfiles/local.example.json")

local function standardWindows(app)
  local windows = {}
  for _, w in ipairs(app:allWindows()) do
    if w:isStandard() then table.insert(windows, w) end
  end
  return windows
end

-- Focuses the window after `current` among `windows`, in a fixed order, so repeated presses
-- visit every window instead of bouncing between two. False when there is nowhere to go.
local function cycle(windows, current)
  if #windows < 2 or not current then return false end
  -- A sorted copy: callers keep their front-to-back order for when this returns false.
  local sorted = { table.unpack(windows) }
  table.sort(sorted, function(a, b) return a:id() < b:id() end)
  for i, w in ipairs(sorted) do
    if w:id() == current:id() then
      sorted[i % #sorted + 1]:focus()
      return true
    end
  end
  return false
end

-- The agents' shared browsers (home/lib/agent-browser.zsh) are Chromes too: the same app,
-- each started with its own --user-data-dir. Which one a Chrome is: "personal" for mine,
-- or the shared browser's id. Remembered per process, since asking costs a `ps`.
-- Their profiles live where home/lib/agent-browser.zsh puts them: main's in
-- ~/.local/share/agent-browser, each other's in ~/.local/share/agent-browser-<id>.
local AGENT_STATE = HOME .. "/.local/share/agent-browser"
local function agentState(name) return AGENT_STATE .. (name == "main" and "" or "-" .. name) end
local owners = {}
local function chromeOwner(app)
  local pid = app:pid()
  if owners[pid] == nil then
    local command = hs.execute("/bin/ps -o command= -p " .. pid)
    local prefix = "--user-data-dir=" .. AGENT_STATE
    local at = command:find(prefix, 1, true)
    local suffix = at and command:sub(at + #prefix):match("^(%-?[%w_]*)/profile ")
    owners[pid] = suffix == nil and "personal" or (suffix == "" and "main" or suffix:sub(2))
  end
  return owners[pid]
end

-- My own Chrome. The app's bundle ID alone could land on one of the agents'.
local function personalChrome()
  for _, app in ipairs(hs.application.applicationsForBundleID("com.google.Chrome")) do
    if chromeOwner(app) == "personal" then return app end
  end
end

-- A new process hands its arguments to my running Chrome (or starts it), which opens a
-- window: in the given profile, or the last one used.
local function openChrome(...)
  hs.task.new("/usr/bin/open", nil, { "-na", "Google Chrome", "--args", ... }):start()
end

-- The profiles Chrome has loaded, from the files it holds open in each profile's folder.
local function loadedProfiles(app)
  local loaded, count = {}, 0
  for dir in hs.execute("/usr/sbin/lsof -p " .. app:pid() .. " -Fn"):gmatch("/Google/Chrome/([^/\n]+)/") do
    if not loaded[dir] and (dir == "Default" or dir:match("^Profile %d+$")) then
      loaded[dir] = true
      count = count + 1
    end
  end
  return loaded, count
end

-- Which windows belong to a profile ({ dir = "Profile 8", name = "School" }). Chrome names
-- the profile at the end of each window's title ("… - Google Chrome - Noah (School)") only
-- while two or more profiles are loaded; with one, every window is that profile's.
local function profileWindows(app, profile)
  local loaded, count = loadedProfiles(app)
  if not loaded[profile.dir] then return {} end
  local windows = {}
  for _, w in ipairs(standardWindows(app)) do
    local title = w:title()
    -- Browser windows only, not the profile picker ("Who's using Chrome?").
    local browser = title:find("Google Chrome", 1, true)
    local named = title:match("%(" .. profile.name .. "%)$") or title:match("%- " .. profile.name .. "$")
    if browser and (count == 1 or named) then table.insert(windows, w) end
  end
  return windows
end

local function chrome()
  local app = personalChrome()
  if not app or #standardWindows(app) == 0 then return openChrome() end
  local front = hs.application.frontmostApplication()
  if front and front:pid() == app:pid() and cycle(standardWindows(app), app:focusedWindow()) then return end
  app:activate()
end

local function chromeProfile(profile)
  local app = personalChrome()
  local windows = app and profileWindows(app, profile) or {}
  if #windows == 0 then return openChrome("--profile-directory=" .. profile.dir) end
  local front = hs.application.frontmostApplication()
  if front and front:pid() == app:pid() and cycle(windows, app:focusedWindow()) then return end
  -- allWindows lists front to back: the profile's window used last.
  windows[1]:focus()
end

-- Reachable from the `hs` tool, to check them without pressing keys.
Hotkeys = { chrome = chrome, chromeProfile = chromeProfile, personalChrome = personalChrome, profileWindows = profileWindows }

local profileKeys = {}
for _, profile in ipairs(localConfig.chromeProfiles) do
  profileKeys[profile.key] = true
  hs.hotkey.bind({ "cmd", "shift" }, profile.key, function() chromeProfile(profile) end)
end
if not profileKeys.A then hs.hotkey.bind({ "cmd", "shift" }, "A", chrome) end
for key, bundleID in pairs(apps) do
  hs.hotkey.bind({ "cmd", "shift" }, key, function()
    local front = hs.application.frontmostApplication()
    if front and front:bundleID() == bundleID and cycle(standardWindows(front), front:focusedWindow()) then
      return
    end
    -- Also reopens a window when the app is running with none open.
    hs.application.launchOrFocusByBundleID(bundleID)
  end)
end

-- The shared browsers I open from their launchers (agent-browser-mode). Each window of one
-- wears its icon as a badge in the bottom-right corner while it's in front, so I always
-- know whose browser I'm typing in. They run windowed but hidden, and stay out of sight
-- until I open one: from its launcher, its Dock icon or ⌘Tab. One that shows itself
-- (Chrome starting and restoring its windows, an agent's new tab un-hiding it) is hidden
-- again, and one I opened goes back once I'm done with it: when I close its last window,
-- hide it, or leave it out of the front for a while.
local IDLE = 15 * 60
local function agentBrowser(app)
  local name = app and app:bundleID() == "com.google.Chrome" and chromeOwner(app)
  return name ~= "personal" and name or nil
end

local badge = hs.canvas.new({ x = 0, y = 0, w = 36, h = 36 }):level(hs.canvas.windowLevels.floating)
local badgeFor
local function updateBadge()
  local window = hs.window.focusedWindow()
  local name = window and agentBrowser(window:application())
  local icon = name and HOME .. "/.config/agent-browser/" .. name .. "/icon.png"
  if not (icon and hs.fs.attributes(icon) and window:isStandard()) then
    badge:hide()
    return
  end
  if badgeFor ~= name then
    badge[1] = { type = "image", image = hs.image.imageFromPath(icon), imageScaling = "scaleProportionally" }
    badgeFor = name
  end
  local frame = window:frame()
  badge:topLeft({ x = frame.x + frame.w - 46, y = frame.y + frame.h - 46 }):show()
end
-- hs.window.filter loads hs.spaces, which reads the Dock's app as it loads and fails while
-- the Dock isn't running yet. At login Hammerspoon can start minutes before it.
local function dockRunning() return #hs.application.applicationsForBundleID("com.apple.dock") > 0 end
DockWaiter = hs.timer.waitUntil(dockRunning, function()
  BadgeWatcher = hs.window.filter.new("Google Chrome")
    :subscribe({ hs.window.filter.windowFocused, hs.window.filter.windowUnfocused, hs.window.filter.windowMoved,
      hs.window.filter.windowDestroyed, hs.window.filter.windowMinimized }, function() hs.timer.doAfter(0, updateBadge) end)
end, 1)
-- Whether I have it open to look at (agent-browser-mode keeps the same file).
local function opened(name) return hs.fs.attributes(agentState(name) .. "/visible") ~= nil end
local function setOpened(name, yes)
  local path = agentState(name) .. "/visible"
  if yes then
    local file = io.open(path, "w")
    if file then file:close() end
  else
    os.remove(path)
  end
end

-- How long a process has run, in seconds. A shared Chrome brings itself to the front while
-- it starts and restores its windows, which isn't me opening it. (Asked of the process,
-- since the app watcher can report its launch after that.)
local STARTING = 20
local function runningFor(pid)
  local elapsed = hs.execute("/bin/ps -o etime= -p " .. pid):match("[%d:%-]+")
  if not elapsed then return math.huge end
  -- [[days-]hours:]minutes:seconds
  local days, clock = elapsed:match("^(%d+)%-(.+)$")
  local seconds = 0
  for part in (clock or elapsed):gmatch("%d+") do seconds = seconds * 60 + tonumber(part) end
  return (tonumber(days) or 0) * 86400 + seconds
end
local function agentChromes()
  local found = {}
  for _, app in ipairs(hs.application.applicationsForBundleID("com.google.Chrome")) do
    local name = agentBrowser(app)
    if name then found[name] = app end
  end
  return found
end

local watcher = hs.application.watcher
FocusWatcher = watcher.new(function(_, event, app)
  if event == watcher.activated or event == watcher.deactivated then updateBadge() end
  if not (app and app:bundleID() == "com.google.Chrome") then return end
  local name = agentBrowser(app)
  if not name then return end
  if event == watcher.activated then
    if not opened(name) and runningFor(app:pid()) < STARTING then
      app:hide()
    else
      -- I picked it, from the Dock or ⌘Tab.
      setOpened(name, true)
    end
  elseif event == watcher.hidden then
    setOpened(name, false)
  elseif event == watcher.terminated then
    owners[app:pid()] = nil
  end
end):start()

-- One I haven't opened stays hidden. Chrome un-hides itself when it opens a window (as it
-- starts, or for an agent's tab) without telling the app watcher, so this looks every
-- second; it asks nothing of Chrome itself, which can be too busy to answer.
KeepHidden = hs.timer.doEvery(1, function()
  for name, app in pairs(agentChromes()) do
    if not app:isHidden() and not opened(name) then app:hide() end
  end
end)

-- For agent-browser-mode, through the `hs` tool: macOS lets only the app in front (or one
-- with Hammerspoon's permissions) bring another app forward. True when that browser runs.
AgentBrowsers = {
  show = function(name)
    setOpened(name, true)
    local app = agentChromes()[name]
    if not app then return false end
    app:unhide()
    -- Through its window: macOS ignores a request to activate an app that comes from one
    -- that isn't in front, Hammerspoon included, but focusing a window still works. A
    -- window that was hidden a moment ago takes a moment to be reachable.
    local function focus(tries)
      local window = app:mainWindow() or standardWindows(app)[1]
      if window then
        window:focus()
      elseif tries > 0 then
        hs.timer.doAfter(0.1, function() focus(tries - 1) end)
      else
        app:activate(true)
      end
    end
    focus(20)
    return true
  end,
  hide = function(name)
    setOpened(name, false)
    local app = agentChromes()[name]
    if app then app:hide() end
    return app ~= nil
  end,
}

local lastSeen = {}
HideTimer = hs.timer.doEvery(30, function()
  for _, app in ipairs(hs.application.applicationsForBundleID("com.google.Chrome")) do
    local name = agentBrowser(app)
    local visible = name and hs.fs.attributes(agentState(name) .. "/visible")
    if name and not visible then
      lastSeen[name] = nil
      -- Missed while Hammerspoon wasn't running, say.
      if not app:isHidden() then app:hide() end
    elseif name then
      if app:isFrontmost() or not lastSeen[name] then lastSeen[name] = os.time() end
      -- A moment's grace after it's opened, while it opens a window for its tab.
      local settled = os.time() - visible.modification > 10
      if settled and (#standardWindows(app) == 0 or os.time() - lastSeen[name] > IDLE) then
        lastSeen[name] = nil
        app:hide()
      end
    end
  end
end)


-- A Time Machine backup's progress in the menu bar ("Backup 17% · 4h 42m left") while one
-- runs; gone the rest of the time. Clicking it shows the details. Its place, at the left end,
-- is in home.nix (home.activation.menuBarOrder).
local function duration(seconds)
  local hours, minutes = math.floor(seconds / 3600), math.floor(seconds % 3600 / 60)
  return hours > 0 and string.format("%dh %dm", hours, minutes) or string.format("%dm", math.max(minutes, 1))
end
local function gigabytes(bytes) return string.format("%.0f GB", bytes / 1e9) end

BackupItem = hs.menubar.new(false, "backup")
local function updateBackup()
  hs.task.new("/usr/bin/tmutil", function(_, out)
    local status = hs.plist.readString(out or "") or {}
    if not status.Running then
      BackupItem:removeFromMenuBar()
      return
    end
    local progress = status.Progress or {}
    local percent = tonumber(progress.Percent or status.Percent or -1) or -1
    local left = tonumber(progress.TimeRemaining)
    local title = "Backup"
    if percent >= 0 then title = title .. string.format(" %d%%", math.floor(percent * 100)) end
    if left then title = title .. " · " .. duration(left) .. " left" end
    -- Phases are CamelCase names (ThinningPreBackup): split into words for the menu.
    local phase = (status.BackupPhase or "Starting"):gsub("(%l)(%u)", "%1 %2")
    local menu = { { title = "Time Machine: " .. phase, disabled = true } }
    if progress.bytes and progress.totalBytes then
      table.insert(menu, { title = gigabytes(progress.bytes) .. " of " .. gigabytes(progress.totalBytes) .. " copied", disabled = true })
    end
    if status.DestinationMountPoint then
      table.insert(menu, { title = "To " .. status.DestinationMountPoint, disabled = true })
    end
    table.insert(menu, { title = "-" })
    table.insert(menu, { title = "Time Machine Settings…", fn = function()
      hs.execute("/usr/bin/open 'x-apple.systempreferences:com.apple.Time-Machine-Settings.extension'")
    end })
    BackupItem:setTitle(title):setMenu(menu):returnToMenuBar()
  end, { "status", "-X" }):start()
end
updateBackup()
BackupTimer = hs.timer.doEvery(15, updateBackup)

-- A display plugged in (or switched to a new resolution) gets the Lilac Moon wallpaper on its
-- own: wallpaper/new-displays.sh builds the size if it's new (about a minute) and sets it.
-- Plugging in sends a burst of events, so it runs once things have been quiet for 3 seconds.
local wallpaperTask, wallpaperAgain
local function wallpaperForDisplays()
  -- A change during a build runs it once more afterward, for a display plugged in meanwhile.
  if wallpaperTask and wallpaperTask:isRunning() then wallpaperAgain = true return end
  wallpaperTask = hs.task.new("/bin/sh", function(code, built, err)
    if code ~= 0 then
      hs.notify.new({ title = "Wallpaper", informativeText = "Couldn't set up the new display's wallpaper: run ~/.dotfiles/wallpaper/new-displays.sh to see why." }):send()
      print("wallpaper: new-displays.sh exited " .. code .. "\n" .. (err or ""))
    elseif built ~= "" then
      hs.notify.new({ title = "Wallpaper", informativeText = "Lilac Moon is on the new display." }):send()
    end
    if wallpaperAgain then
      wallpaperAgain = false
      hs.timer.doAfter(0, wallpaperForDisplays)
    end
  end, { HOME .. "/.dotfiles/wallpaper/new-displays.sh" })
  wallpaperTask:start()
end
local wallpaperDelay = hs.timer.delayed.new(3, wallpaperForDisplays)
DisplayWatcher = hs.screen.watcher.new(function() wallpaperDelay:start() end):start()
-- Also at login and on each reload, for a display plugged in while Hammerspoon wasn't running.
wallpaperDelay:start()

-- This file is a live link into the dotfiles repo: watch the real file, and reload on a save.
ConfigWatcher = hs.pathwatcher.new(hs.fs.pathToAbsolute(hs.configdir .. "/init.lua"), hs.reload):start()
hs.autoLaunch(true)
hs.dockIcon(false)
hs.menuIcon(false)
