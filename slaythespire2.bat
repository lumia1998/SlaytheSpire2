@echo off
setlocal

if exist "mods" (
    ren "mods" "mods_origin"
)

git clone https://github.com/lumia1998/mods

exit
