import { MessageType } from "./shared/constants.js";

const ALARM_NAME = "pomodoro";

function formatTime(ms: number): string {
    const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
    const m = Math.floor(totalSeconds / 60);
    const s = totalSeconds % 60;
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export async function initPomodoro(): Promise<void> {
    const setupEl = document.getElementById("pomodoro-setup");
    const activeEl = document.getElementById("pomodoro-active");
    const minutesInput = document.getElementById("pomodoro-minutes") as HTMLInputElement | null;
    const startBtn = document.getElementById("pomodoro-start");
    const cancelBtn = document.getElementById("pomodoro-cancel");
    const countdownEl = document.getElementById("pomodoro-countdown");
    const blockToggle = document.getElementById("block-toggle") as HTMLInputElement | null;

    if (!setupEl || !activeEl || !minutesInput || !startBtn || !cancelBtn || !countdownEl) return;

    let intervalId: ReturnType<typeof setInterval> | null = null;

    function showSetup(): void {
        setupEl!.style.display = "";
        activeEl!.style.display = "none";
        if (blockToggle) blockToggle.disabled = false;
        if (intervalId !== null) { clearInterval(intervalId); intervalId = null; }
    }

    function showActive(scheduledTime: number): void {
        setupEl!.style.display = "none";
        activeEl!.style.display = "";
        if (blockToggle) { blockToggle.checked = true; blockToggle.disabled = true; }

        if (intervalId !== null) clearInterval(intervalId);
        countdownEl!.textContent = formatTime(scheduledTime - Date.now());

        intervalId = setInterval(() => {
            const remaining = scheduledTime - Date.now();
            if (remaining <= 0) {
                countdownEl!.textContent = "00:00";
                showSetup();
                if (blockToggle) blockToggle.checked = false;
            } else {
                countdownEl!.textContent = formatTime(remaining);
            }
        }, 1000);
    }

    const existing = await chrome.alarms.get(ALARM_NAME);
    if (existing) showActive(existing.scheduledTime);

    startBtn.addEventListener("click", async () => {
        const raw = parseInt(minutesInput.value, 10);
        const minutes = Math.min(180, Math.max(1, isNaN(raw) ? 25 : raw));
        minutesInput.value = String(minutes);

        await chrome.runtime.sendMessage({ type: MessageType.SET_POMODORO, enabled: true, durationMinutes: minutes });

        const alarm = await chrome.alarms.get(ALARM_NAME);
        if (alarm) showActive(alarm.scheduledTime);
    });

    cancelBtn.addEventListener("click", async () => {
        await chrome.runtime.sendMessage({ type: MessageType.SET_POMODORO, enabled: false });
        showSetup();
        if (blockToggle) blockToggle.checked = false;
    });
}
