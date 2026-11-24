#!/usr/bin/env bash
# package.json version이 최신 vX.Y.Z 태그보다 높은지 확인하고 GITHUB_OUTPUT에 남긴다.
set -euo pipefail
version=$(node -p "require('./package.json').version")
if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "::error::package.json version($version)이 X.Y.Z 형식이 아닙니다."
  exit 1
fi
latest=$(git tag --list 'v[0-9]*.[0-9]*.[0-9]*' --sort=-v:refname | sed -n '1s/^v//p')
highest=$(printf '%s\n' "${latest:-0.0.0}" "$version" | sort -V | tail -n 1)
if [[ "$version" == "$latest" || "$highest" != "$version" ]]; then
  echo "::error::package.json version($version)을 최신 릴리스(v$latest)보다 올려 주세요."
  exit 1
fi
echo "version=$version" >> "${GITHUB_OUTPUT:-/dev/null}"
echo "OK: v$latest -> v$version"
