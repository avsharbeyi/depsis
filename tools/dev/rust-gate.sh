#!/usr/bin/env bash
#
# Rust kapısını, araç zincirinin GERÇEKTEN kurulu olduğu WSL dağıtımında koşturur.
#
# Windows tarafından çağrılır:  bash tools/dev/rust-gate.sh
#
# NEDEN VAR. Depodaki `wsl-*.sh` betikleri `wsl.exe`'yi dağıtım seçmeden çağırıyor, yani
# VARSAYILAN dağıtımda koşuyorlar. Bu makinede varsayılan dağıtım araç zincirini taşımıyor;
# `cargo` yalnızca bir başkasında kurulu. Sonuç, kapının koşmadığını söylemeyen bir hata oluyordu:
# "cd: /mnt/c/...: No such file or directory" ya da "cargo: command not found". İkisi de bir
# derleyici hatası gibi görünmüyor, bir ortam kazası gibi görünüyor, ve kapı atlanıyor.
#
# Bir kapının koşmaması, kırmızı vermesinden daha tehlikelidir: kırmızı bakılacak yeri söyler.
set -Eeuo pipefail

REPO_UNIX='/mnt/c/Users/HUAWEI/Desktop/xdepsisOS'

# `wsl.exe --list --quiet` çıktısı UTF-16 ve satır sonları CRLF; ikisi de temizleniyor.
mapfile -t DISTROS < <(wsl.exe --list --quiet 2>/dev/null | tr -d '\000\r' | sed '/^$/d')

for distro in "${DISTROS[@]}"; do
  if wsl.exe -d "$distro" -e bash -lc 'test -x "$HOME/.cargo/bin/cargo"' 2>/dev/null; then
    printf 'Rust araç zinciri: %s\n' "$distro"
    exec wsl.exe -d "$distro" -e bash -lc \
      "cd '$REPO_UNIX' && bash tools/dev/wsl-rust-gate.sh"
  fi
done

printf 'Hicbir WSL dagitiminda cargo bulunamadi. Bakilan dagitimlar: %s\n' "${DISTROS[*]}" >&2
printf 'Kurulum: wsl -d <dagitim> -- curl --proto =https --tlsv1.2 -sSf https://sh.rustup.rs | sh\n' >&2
exit 1
