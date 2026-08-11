#!/bin/sh
# Все стенды splify2 одной командой.
#
# Зачем отдельный вход. Урок запуска 26: пометка «стенд создан» ничего не стоит, пока
# стенд не подключён к тому, что запускают. Стенд, который надо вспомнить и позвать
# руками, не запускается никогда — а значит и не сторожит ничего.
#
# Здесь нет Makefile, в отличие от steer: у splify2 нет сборки на C, и единственная
# зависимость стендов — python3 плюс node для интерфейса.
#
# Запуск: sh tests/run.sh
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fails=0

run() {  # ИМЯ КОМАНДА...
    name="$1"; shift
    printf '\n===== %s =====\n' "$name"
    if "$@"; then
        printf '%s: зелено\n' "$name"
    else
        printf '%s: ПРОВАЛ\n' "$name"
        fails=$((fails + 1))
    fi
}

run listsmatch sh "$ROOT/tests/listsmatch.sh"
run rpcdmatch  sh "$ROOT/tests/rpcdmatch.sh"

# Интерфейс. Пропускается вслух, а не молча: молчаливый пропуск читается как «прошло», и
# ровно так стенд однажды и превратился в фикцию.
#
# Требуется node ≥ 20.19: vitest 4 и vite 8 на node 18 не работают. Как ставился локально —
# записано в STATE.md, раздел «Окружение».
if [ -d "$ROOT/ui/node_modules/vitest" ]; then
    node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
    if [ "$node_major" -ge 20 ] 2>/dev/null; then
        run ui-harness sh -c "cd '$ROOT/ui' && npm test --silent"
    else
        printf '\n===== ui-harness =====\nПРОПУЩЕН: нужен node >= 20, найден %s\n' "$(node --version 2>/dev/null || echo 'нет node')"
        fails=$((fails + 1))
    fi
else
    printf '\n===== ui-harness =====\nПРОПУЩЕН: не установлен (cd ui && npm install)\n'
    fails=$((fails + 1))
fi

printf '\n%s\n' "$([ "$fails" -eq 0 ] && echo 'ВСЕ СТЕНДЫ ЗЕЛЁНЫЕ' || echo "СТЕНДОВ С ПРОВАЛОМ: $fails")"
[ "$fails" -eq 0 ]
