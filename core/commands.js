// ═══════════════════════════════════════════
// core/commands.js — ALL imports at top
// ═══════════════════════════════════════════
import { Weather }         from "./weather.js";
import { Alarms, normaliseTime } from "./alarms.js";
import { Storage }         from "./storage.js";
import { CONFIG }          from "./config.js";
import { webSearch, deepResearch, smartSearch, formatResults, businessResearch, inspectUrl, formatUrlResult } from "./websearch.js";
import { saveGoals, getTodayGoals, completeGoal, getStats, formatGoalsForAI } from "./goals.js";
import { parseGithubUrl, getRepoTree, getFile, getFiles, searchRepos, pickRelevantFiles, formatRepoSummary, formatSearchResults, createRepo, createOrUpdateFile, scaffoldRepo, createBranch, deleteFile, createPR, listBranches } from "./github.js";
import { parseAgentCommand, activateAgent, deactivateAgent, getActiveAgent, AGENTS } from "./agent.js";

// Sanitize file content before pushing — removes control chars that break JSON
function _sanitizeContent(str) {
  if (typeof str !== "string") return String(str || "");
  return str
    .replace(/
/g, "
")   // normalize line endings
    .replace(/
/g, "
")
    // Remove non-printable control chars EXCEPT tab(	) newline(
)
    .replace(/[
