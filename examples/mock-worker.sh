#!/usr/bin/env bash
# Stand-in for `qwen` used by the test-suite. Reads .crew/BRIEF.md and behaves according to keywords.
B=$(cat .crew/BRIEF.md)
echo "[mock] $CREW_WORKER working on task $CREW_TASK_ID"
if echo "$B" | grep -q STREAMLIVE; then curl -s -N -X POST "$OPENAI_BASE_URL/chat/completions" -H "authorization: Bearer $OPENAI_API_KEY" -H 'content-type: application/json' -d '{"model":"m","stream":true,"messages":[{"role":"system","content":"x"}]}' > /dev/null; sleep 5; fi
if echo "$B" | grep -q SLOWLIVE; then printf '\033[32mstep one\033[0m\n'; echo early > early.txt; sleep 6; echo "step two"; fi
if echo "$B" | grep -q ASKME && ! echo "$B" | grep -q "Answer to your question"; then
  echo "Should I use tabs or spaces?" > .crew/QUESTION.md; exit 0
fi
if echo "$B" | grep -q FLAKY && ! echo "$B" | grep -q "not accepted"; then
  echo bad > flaky.txt; echo "I tried" > .crew/REPORT.md; exit 0
fi
if echo "$B" | grep -q FLAKY; then echo good > flaky.txt; fi
f="out_$CREW_TASK_ID.txt"; echo "hello from $CREW_WORKER" > "$f"
if echo "$B" | grep -q "mock-lesson-marker"; then echo "SAW LESSON" >> "$f"; fi
if echo "$B" | grep -q "Feedback on your previous attempt"; then echo "FIXED" >> "$f"; fi
if echo "$B" | grep -q "passwordless"; then echo "SANDBOXNOTE" >> "$f"; fi
if echo "$B" | grep -q "Do not delegate to sub-agents"; then echo "NOSUBAGENTS" >> "$f"; fi
if echo "$B" | grep -q "Standing instructions"; then echo "STANDING" >> "$f"; fi
echo "I wrote $f. model=$OPENAI_MODEL endpoint=$OPENAI_BASE_URL key=$OPENAI_API_KEY" > .crew/REPORT.md
if grep -q NOTESJOB .crew/BRIEF.md; then printf '\n## Notes for the team\n- API routes live in routes.ts\n' >> .crew/REPORT.md; fi
if grep -q CHECKBRIEF .crew/BRIEF.md; then grep -q 'routes.ts' .crew/BRIEF.md && echo HAS_NOTE >> .crew/REPORT.md; grep -q 'Work from earlier tasks' .crew/BRIEF.md && echo HAS_UPSTREAM >> .crew/REPORT.md; fi
if grep -q PROXYCALL .crew/BRIEF.md; then curl -s -X POST "$OPENAI_BASE_URL/chat/completions" -H "authorization: Bearer $OPENAI_API_KEY" -H "content-type: application/json" -d '{"model":"m","messages":[{"role":"system","content":"x"}]}' >> .crew/REPORT.md; fi
