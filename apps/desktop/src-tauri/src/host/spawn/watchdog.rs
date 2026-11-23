//! A run's time limit and stall window, which don't count the time the computer slept.

use std::time::Duration;

use crate::util::human_duration;

/// How often a run's watchdog looks at the clock.
const WATCH_TICK: Duration = Duration::from_secs(1);
/// A look this late means the computer was asleep since the last one. Windows' clock counts on through a suspend,
/// so a run would otherwise wake up stalled, or past its limit. A busy machine is late by seconds, not this.
const ASLEEP_AFTER: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Copy, PartialEq)]
pub(super) enum Watch {
    Running,
    /// The computer slept for this long (the gap between two looks): the stall clock starts again.
    Slept(Duration),
    /// The run has been awake for its whole time limit.
    TimedOut,
    /// The process has written no stdout line for the stall window. The agent CLIs stream an event for every step,
    /// tool call and message, so a long silence means a hang, not a slow edit.
    Stalled,
}

/// What a run's time limit and stall window make of the time since the last look.
pub(super) struct Watchdog {
    pub(super) limit: Option<Duration>,
    pub(super) stall: Option<Duration>,
    /// Time the run has been going, without the time the computer slept.
    pub(super) awake: Duration,
}

impl Watchdog {
    /// One look at the clock: `gap` since the last look, `quiet` since the process last wrote a line.
    pub(super) fn look(&mut self, gap: Duration, quiet: Duration) -> Watch {
        if gap >= ASLEEP_AFTER {
            return Watch::Slept(gap);
        }
        self.awake += gap;
        if self.limit.is_some_and(|limit| self.awake >= limit) {
            Watch::TimedOut
        } else if self.stall.is_some_and(|stall| quiet >= stall) {
            Watch::Stalled
        } else {
            Watch::Running
        }
    }
}

/// Resolves when the run should be stopped, for its time limit or for going quiet. Never, with neither.
pub(super) async fn watch(limit: Option<Duration>, stall: Option<Duration>, last_line: &std::sync::Mutex<std::time::Instant>, who: &str) -> Watch {
    if limit.is_none() && stall.is_none() {
        return std::future::pending().await;
    }
    let mut dog = Watchdog { limit, stall, awake: Duration::ZERO };
    let mut looked = std::time::Instant::now();
    loop {
        tokio::time::sleep(WATCH_TICK).await;
        let now = std::time::Instant::now();
        let gap = now.saturating_duration_since(looked);
        looked = now;
        let quiet = now.saturating_duration_since(*last_line.lock().unwrap());
        match dog.look(gap, quiet) {
            Watch::Running => {}
            Watch::Slept(slept) => {
                *last_line.lock().unwrap() = now;
                log::info!("{who}: the computer was asleep for about {}; its stall and time limits don't count that", human_duration(slept));
            }
            stop => return stop,
        }
    }
}
