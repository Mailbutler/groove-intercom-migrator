import assert from "node:assert/strict";
import test from "node:test";
import { normalizeJiraIssueKeys, parseGrooveJiraIssueMap } from "./jira-map";

test("normalizeJiraIssueKeys extracts and deduplicates issue keys", () => {
  assert.deepEqual(
    normalizeJiraIssueKeys([
      "ER-2508",
      "https://mailbutler.atlassian.net/browse/front-5942",
      "ER-2508",
    ]),
    ["ER-2508", "FRONT-5942"]
  );
});

test("parseGrooveJiraIssueMap supports object format", () => {
  const map = parseGrooveJiraIssueMap({
    "166126": "MP-2676",
    "161765": ["FRONT-5942", "ER-2488"],
  });

  assert.deepEqual(map.get("166126"), ["MP-2676"]);
  assert.deepEqual(map.get("161765"), ["ER-2488", "FRONT-5942"]);
});

test("parseGrooveJiraIssueMap supports entries format", () => {
  const map = parseGrooveJiraIssueMap({
    tickets: [
      {
        grooveTicketId: 162956,
        jiraIssueKeys: ["ER-2508"],
      },
    ],
  });

  assert.deepEqual(map.get("162956"), ["ER-2508"]);
});

test("parseGrooveJiraIssueMap rejects entries without issue keys", () => {
  assert.throws(
    () => parseGrooveJiraIssueMap({ "166126": [] }),
    /does not contain any Jira issue keys/
  );
});
