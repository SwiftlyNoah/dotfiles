#!/bin/zsh
# Checks mac-check's Automatic updates line against stubbed SoftwareUpdate preferences.
# Run: zsh home/bin/mac-check.test.zsh
# Every tool mac-check calls is a function here, which zsh runs before anything on PATH, so
# no real check runs and a broken stub fails instead of reaching the real tool.
emulate -L zsh
mac_check=${0:A:h}/mac-check
integer fails=0

updates() { # expected Automatic updates line, then KEY=value for each key present
  local want=$1 got; shift
  got=$(
    typeset -A prefs
    for kv; prefs[${kv%%=*}]=${kv#*=}
    defaults() {
      [[ $1 == read && $2 == /Library/Preferences/com.apple.SoftwareUpdate ]] || return 1
      (( ${+prefs[$3]} )) && print -- $prefs[$3]
    }
    for tool in fdesetup pmset sysadminctl tmutil df git profiles scutil \
      /usr/libexec/ApplicationFirewall/socketfilterfw; do
      functions[$tool]=:
    done
    set --
    source $mac_check | grep -E "^(PASS|FAIL)  Automatic updates:"
  )
  [[ $got == $want ]] && print "ok    $want" || { print "FAIL  want: $want\n      got:  $got"; fails+=1; }
}

on=(AutomaticCheckEnabled=1 AutomaticDownload=1 CriticalUpdateInstall=1 ConfigDataInstall=1)
updates "PASS  Automatic updates: check, download, security responses and macOS installs on" \
  $on AutomaticallyInstallMacOSUpdates=1
updates "FAIL  Automatic updates: AutomaticallyInstallMacOSUpdates is off" \
  $on AutomaticallyInstallMacOSUpdates=0
updates "FAIL  Automatic updates: AutomaticCheckEnabled, AutomaticallyInstallMacOSUpdates are off" \
  ${on:#AutomaticCheckEnabled=*} AutomaticCheckEnabled=0 AutomaticallyInstallMacOSUpdates=0
# macOS leaves AutomaticCheckEnabled out while checking is at its default, on.
updates "PASS  Automatic updates: check, download, security responses and macOS installs on" \
  ${on:#AutomaticCheckEnabled=*} AutomaticallyInstallMacOSUpdates=1
# Absent, macOS installs updates only when asked, so it still fails.
updates "FAIL  Automatic updates: AutomaticallyInstallMacOSUpdates is off" $on
updates "FAIL  Automatic updates: ConfigDataInstall is off" \
  ${on:#ConfigDataInstall=*} AutomaticallyInstallMacOSUpdates=1

(( fails == 0 ))
