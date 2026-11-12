# Document pilot — approved scope, 2026-11-11

Owner requests: no mandatory teacher for pilot; automatic checking, hints, points and progress; personal documents and mini-courses/tests in ANY educational subject. Local existing model, no paid API, new weights or embeddings/RAG. New request authorizes the necessary Django/frontend integration. Preserve old sources, reports and databases. No merge/push or shutdown.

## Chosen vertical slice

Private StudyPack objects inside documents app, separate from public Python Course objects. This avoids making existing public course serializers responsible for private content. Display packs and their progress on Documents page and a dedicated study page. Existing Python grading remains automatic. Generated tests are single-choice (four distinct options, one key), automatically scored against AI-authored keys. Do not claim an LLM inference occurs for each choice or that AI is infallible. No required teacher/manual approval state. Failure produces no grade.

Upload TXT UTF-8, PDF with text, DOCX, PPTX up to 20 MiB. Local extraction only, bounded at 200000 characters, explicit error for empty/scanned/unsupported/encrypted or too-large text; no silent truncation. Avoid logging text/filenames. Optional parser imports so TXT works without parsers; pinned document dependencies installed by pilot setup. Private originals never served by static server. No HTML rendering of model/document text. Owner filter on every document, pack, job, hint, attempt and lesson-document endpoint. Do not expose filesystem URL or secret answer keys in student GET responses.

Generation uses an explicitly selected contiguous excerpt of 100..6000 Unicode characters. Small documents default whole; larger UI shows exact selected range and says only that excerpt is covered. No false claim full long-document coverage. No embeddings/chunk retrieval. Mode course = 1..3 short lessons and 3..7 questions (legacy packs; new UI requests exactly 5, 6 or 7); mode test = no lessons and 3..7 questions (legacy packs; new UI requests exactly 5, 6 or 7). Title, lessons, questions, keys, hints, explanations come from the local model. Every lesson/question includes a nonempty verbatim source quote (20..500 characters); strict schema, bounds and duplicates validated on both Node and Django. Citation presence is traceability, not proof of truth. Invalid generation fails closed; no regex/default answer fallback.

## Frozen interfaces

Public API prefix /api/v1/documents/ (JWT):
- GET/POST '' documents list/upload; item {id,title,mime_type,status,created_at,error,text_length}; file is not exposed.
- GET '<id>/' detail includes extracted_text; DELETE same (block if active generation).
- GET '<id>/download/' authenticated file response attachment (optional UI omitted if difficult).
- POST '<id>/generate/' body {request_id:UUID,mode:'course'|'test',source_start:int,source_end:int}; returns pack status (202). Range indexes use Unicode code points, server authoritative. Idempotency owner+request_id; changed inputs 409. One active generation per owner, global queue cap 8.
- GET 'packs/' list private packs.
- GET 'packs/<id>/' public pack (no keys/quotes for questions before submission), status, error_code, source_start/end, mode,title,lessons,questions,progress; status queued/running/ready/failed/unknown. Lesson fields title/content/source_quote; question fields id/prompt/options (4 strings). IDs assigned server as q1..qN. progress {answered,total,score,max_score,percent,completed}, latest answer per question; completion means all answered, score means correct percentage.
- POST 'packs/<id>/hints/' {question_id} => {hint}, no answer key.
- POST 'packs/<id>/attempts/' {request_id:UUID,question_id,choice:0..3} => {id,question_id,choice,correct,score:0|1,max_score:1,feedback,source_quote,progress}. Idempotency same id+same body, changed body409; latest-per-question no farming points. Hint usage does not change points. Other owner's resources 404.

Private Node IPC /study and /study/receipt same existing secret header and envelope {body,resolved}. Body {request_id:UUID,mode,source_text} (100..6000 chars); resolved {actor_id:string}. /study returns {status:'ready'|'failed'|'unknown',result:StudyResult|null,error_code:string|null}; receipt same or {status:'pending'|'missing',result:null,error_code:null}. Durable SQLite pending BEFORE model dispatch; identity actor+request ID+hash(mode/source), conflict rejects. Unknown/pending NEVER auto rerun POST. Concurrent exact duplicate joins flight. Receipt reads persisted result. Restart pending becomes unknown. Logs metadata only.

StudyResult JSON: {title:string<=160,lessons:[{title:string<=160,content:string<=1800,source_quote:string20..500}],questions:[{prompt:string<=500,options:[4 strings1..250],correct_index:int0..3,hint:string1..400,explanation:string1..600,source_quote:string20..500}]}. No additional properties. mode test lessons=[], course 1..3. Questions 3..7; explicit generation options require the exact requested count. No null/nan/bool-as-int/duplicate prompt or options. source quote exact substring. Empty strings invalid. Plain text only in UI (escape everywhere).

Django management command run_study_jobs runs one durable queued job at a time using atomic conditional claim. POST dispatch is recorded before sending. On startup/interruption running jobs only GET/POST receipt (read-only operation), never repeat generation. A running receipt pending remains running; missing/unknown becomes unknown. Persist result after independent validation and ensure owner/document still exists; deletion while active blocked. Network result uncertain => unknown and later receipt can recover. Catch per-job failures without killing whole queue; waiting loop sleeps bounded. Provide --once for tests and launcher.

Shared model: extend existing Tutor/LocalModel for study generation, use SAME busy slot/coordinator/owned model and quarantine. Dedicated study budget 180s, up to 2400 output tokens; existing tutor 8s budget unchanged. Study waiting uses bounded queue; quick tutor cannot wait minutes and returns busy/budget honestly. No second model instance or independent HTTP client bypass. Disable/timeout quarantines dispatched uncertain work; late work cannot overwrite terminal result. Worker HTTP envelope/body cap already sufficient; set timeouts deliberately for study. Existing local model can be enabled via operator as before. New isolated runtime/ports for live testing, do not stop user’s existing services.

## Work plan and file ownership

1. Node implementer: integration/ai/{study*.mjs,worker-http.mjs,bridge.mjs,lifecycle.mjs,core/src/tutor.mjs,core/src/local-model.mjs}, focused tests. Implement strict output schema, durable replay/receipt and shared-slot model role; tests against fake model plus current Node suites.
2. Django implementer: backend/documents/**, backend/config/ai_local*.py, necessary owner filter in courses/views.py; tests. Private models/migrations, upload/extraction with no embeddings, jobs/receipts and automatic grading/progress, API contract above. No global Course changes. Leave setup/requirements/root README to root.
3. Frontend implementer: assets/app.js, assets/data.js, assets/styles.css (discover real CSS); dedicated Study route, documents upload/selection/generation/status/errors, MCQ/hint/results/progress, teacher-free wording. Tests where existing harness supports. No Node/backend edits.
4. Root: isolation/snapshot, dependency setup and portable pilot launcher (Django+Node+study command+frontend, requirements/README), run combined tests, fresh live model examples from multiple subjects, browser end-to-end, package source+instructions+manifest and update canonical roadmap/sole STATUS. Retain logs/reports; final independent review.

## Verification / acceptance

Privacy two accounts; forged ownership/grade/request IDs; malformed/truncated model JSON; misleading quoted keys are a documented quality risk, not considered solved by schema; queued concurrent jobs; crash after dispatch plus receipt; duplicate attempts do not inflate points; partial failed extraction; scanned PDF; large/zip-bomb files; XSS plain text; original four Python grading tests unchanged. Real model test at least three topics (history/biology/math) with synthetic documents and rubric checked by root; no actual student scores touched. Report real vs mocked checks separately.

## Pre-flight interface scan

Ruling after real synthetic output: generation is constrained to one concise lesson and three questions within the original accepted bounds. Source quotes come from deterministic exact substrings in a schema enum; no fuzzy correction. A second blind pass of the same local model sees source/questions/options/hints without candidate keys or explanations and must select the same unique supported keys. Wrong/ambiguous keys fail closed. A hint flagged unsafe is replaced with a fixed neutral process cue, not a claimed generated answer; it does not veto an otherwise valid pack. This narrow fallback followed an observed over-rejection of safe hints, and never applies to keys/lessons. This is correlated automatic checking, not independent validation. Tutor's total study budget remains180s. Known first failures and raw synthetic outputs are retained.

Ruling: existing Python auto_checked attempts can unlock further hints only after server validation of current task/rubric/content digest, canonical request UUID, three booleans, exact answer evidence and recomputed score. They keep auto_checked status; no human approval is fabricated. Explicitly reviewed historic attempts retain their prior behavior.

Ruling after content review: a generated mini-lesson can omit facts needed by its quiz. Public owner-only pack detail also returns source_excerpt (the immutable selected text snapshot, never keys); study UI displays it as plain text before the questions. This gives the learner the complete selected material and makes scope inspectable. It does not claim the generated summary/citation is complete.

| Pair/task | Shared interface | Ruling |
|---|---|---|
| Node/Django | /study+receipt, StudyResult | Exact contract above; no hidden answer keys exposed |
| Django/UI | packs/routes/progress/code-point offsets | Exact contract above; UI Array.from for offsets |
| Setup/all | ports/runtime/dependencies | Root owns launcher; agents use env port/runtime |
| Node | timeouts vs queue/recovery | Long role uses same slot; never weaken tutor8s or quarantine |
| Django | owner/privacy vs global courses | Separate packs; protect lesson documents too |
| UI | user automation vs errors | No teacher gate; explicit error with no grade |
| Root | current stage vs historical freeze | Latest explicit feature request supersedes old freeze for this scope |

Implementation ledger and evidence are kept in outputs/document-pilot-2026-11-11 outside frozen incoming source. This is a feature spec, not another canonical roadmap or STATUS.

## Generation preferences (2026-11-12)

The generation endpoint additionally accepts optional `generation_options: {question_count: 5|6|7, detail: 'concise'|'detailed'}`. Both keys are required when the object is present; no other keys are accepted. The UI defaults to six questions and offers a choice immediately before enqueue. Settings in the profile supply browser-local defaults, not a global model configuration.

The additive Django migration `0007_study_generation_options` stores the exact options with each pack. Apply it only after backing up the target runtime/database. Existing rows get `{}` and retain the old request shape and receipt fingerprint. The main database has not been migrated by this feature's verification. New options are included in Django conflict checks and the Node digest, including receipt reads; unknown requests are not automatically reissued. The public pack includes generation_options. New generation and final validation require the chosen question count, with no filler or truncation fallback.

For explicit options the model output cap is 768 × (question_count + 1), at most 6144 tokens; each verifier cap is 384 × question_count. The existing 180-second study deadline, queue, quarantine, verification gates and assessment prompts are unchanged. Two small pinned-core overrides carry the options and these caps; LOCAL_OVERRIDES.json records the updated SHA256. No new weights or inference API is used. Larger generation has not yet been timed or pedagogically validated on the local GPU.

`detail` affects the new lecture and per-option explanations. The profile's answer detail adds a bounded style instruction to new code-tutor questions, preserves the original code snapshot and retry body, and never changes assessment criteria. Existing packs/grades are not rewritten. The helper question field allows 1900 characters to reserve room within the 2000-character contract.

Lecture rendering escapes all text, supports headings/lists/fenced code, and groups long prose by sentences. Python submission updates its result inline; history shows the latest attempt per exercise and retains earlier attempts under a disclosure. Every route includes the small AI error notice. These presentation changes do not delete attempts or alter scores.
