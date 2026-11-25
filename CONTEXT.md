# Edison

Edison's product language covers the YouTube reading workbench, Curriculum and the Body profile.

## YouTube reading language

- **Report**: A complete, author-designed HTML document in a channel directory. Edison opens the original local file.
- **Channel**: A named folder grouping reports. Report update time orders the feed across channels.
- **Reading state**: Local read and featured selections follow the file across renames and channel moves. Featuring a report marks it read.
- **Local reading library**: Edison scans the agent’s channel folders on launch and updates its open reading list on filesystem events.

## Curriculum language

**Curriculum（课程模块）**:
The person's university course workspace, containing the Timetable and Course archive. Personal tasks and schedule editing are outside this module's scope.
_Avoid_: Task planner, schedule editor

**Timetable（课表）**:
The weekly view of scheduled university courses, combining the academic calendar and class period times. It is distinct from the Course archive of recorded classroom documents.
_Avoid_: Course archive, schedule editor

**Course occurrence（一次课程安排）**:
A course scheduled on a particular date and time, with its assigned classroom and teacher. Separate occurrences of the same course may have different rooms or teachers.
_Avoid_: Course definition, personal task

**Course-free interval（无课时段）**:
A gap between known course commitments within a covered timetable period. It does not establish availability for other commitments.
_Avoid_: Guaranteed availability, missing timetable

**Class period（课程节次）**:
One numbered teaching interval in the university's daily timetable, with its own start and end time. A single course occurrence can contain several periods separated by breaks.
_Avoid_: Entire course occurrence, weekly course

**Classroom source transcript（课堂原始字幕）**:
The preserved, unedited transcription supplied by the classroom recording platform, including its available timestamps. It is source material for a classroom document and does not establish that every spoken passage was captured.
_Avoid_: Classroom document, corrected transcript, complete classroom record

**Classroom document（课堂整理文档）**:
A reading document organized from source material for a platform-recorded class. It can be an edited transcript or detailed revision notes; neither replaces its source transcript.
_Avoid_: Raw subtitles, course definition

**Edited classroom transcript（字幕整理稿）**:
A lightly edited, time-referenced rendering of platform captions. It may remove meaningless repetitions and fillers, correct clear typos and improve punctuation and paragraphing, while preserving substantive content, language and order without adding explanations.
_Avoid_: Summary, expanded lecture, guaranteed complete speech record

**Classroom backup（课堂本地备份）**:
A retained copy of the same reader-visible classroom document versions in the person's Homework folder, written by the Homework backup app from Edison's local export. The archive and the backup can be current at different times.
_Avoid_: Another Edison instance, browser cache, Git push

**Platform login（平台登录）**:
The person's own campus sign-in to the classroom recording platform, given by a QR scan in Edison's login window and held only on this Mac. The platform expires it periodically; Edison renews it silently when it can and otherwise asks for a new scan.
_Avoid_: Account password, everyday browser session, shared credential

**Recorded class（录播课次）**:
A classroom session identified and listed by the classroom recording platform. It is the unit of classroom document archiving, distinct from a scheduled course occurrence or a single numbered class period.
_Avoid_: Timetable occurrence, class period, proof of complete recording

**Supplementary classroom transcript（补充转写）**:
A transcription obtained from the recording audio to supplement absent or confirmed incomplete platform subtitles. Its source remains distinct from the preserved platform transcript.
_Avoid_: Original platform subtitles, inferred missing speech

**Course archive（课程档案）**:
The Curriculum collection of classroom documents, grouped by course by default. Source transcripts are retained separately from its reader-facing documents.
_Avoid_: Object Archive, deleted courses


## Learning Gather language

**Learning Gather（学习 Agent 空间）**:
The person's conversations with learning agents around their current core goals, including group conversations and private conversations.
_Avoid_: Human social network, general activity feed

**Core learning goal（核心学习目标）**:
A learning outcome deliberately selected by the person to guide agents' assistance. The goal is distinct from individual practice prompts and any one conversation.
_Avoid_: Reminder schedule, chat topic

**Proactive learning message（主动学习消息）**:
A message initiated by a learning agent to help the person progress toward a core learning goal. Its presence in a conversation is distinct from a notification outside Edison.
_Avoid_: External notification, proof of learning progress

**Learning notification（学习通知）**:
An optional notice outside the learning conversation that draws the person's attention to a learning message. It is independent of whether agents may create messages inside Edison.
_Avoid_: Learning message, required reply

## Body profile language

**Body profile（身体档案）**:
The personal module that records the 22 dimensions and target lengths kept by the clothing measurement guide and shows them on a fitted holographic body. It is a buying aid, not a medical scan or a full tailoring worksheet.
_Avoid_: Body scan, 159-item record sheet, garment database

**Recorded value（采用值）**:
The single adopted reading of one item, in centimetres to 0.1, with its measuring position, posture and note. Paired items are recorded per side. A blank item is unmeasured, never zero.
_Avoid_: Raw reading, average of attempts

**Measurement draft（测量草稿）**:
The editable set of recorded values, saved automatically. Editing the draft never creates history.
_Avoid_: Snapshot, autosave history

**Measurement snapshot（测量快照）**:
A deliberately saved, dated set of recorded values. Correcting a snapshot keeps the replaced content as a revision; deleting it removes it for good.
_Avoid_: Draft, automatic history entry

**Holographic body（全息人体）**:
The Anny body fitted to the recorded values and shown as a hologram. Items it does not measure are displayed as inferred values. It is a visual approximation, not a reconstruction of real cross-sections.
_Avoid_: 3D scan, avatar

**Inferred value（推断值）**:
What the fitted body measures for an item the person has not recorded. It is shown dimmed and is never stored as a recorded value.
_Avoid_: Default value, estimate entered by the person

**Reference layer（参考层）**:
A line drawn on the body for a target length, boot top or watch cuff. It never changes the body's shape.
_Avoid_: Body dimension, garment size

**Ghost comparison（幽灵对比）**:
An earlier snapshot's fitted body overlaid on the current one, with the regions that changed glowing.
_Avoid_: Before/after photo
