// Efficiency mode's signal for the page (app/core/power.js): lowPower is true while Windows saves power,
// that is while energy saver (Windows 11) or battery saver (Windows 10) is on. MainWindow feeds it
// GetSystemPowerStatus().SystemStatusFlag and the GUID_POWER_SAVING_STATUS / GUID_ENERGY_SAVER_STATUS
// notifications (WM_POWERBROADCAST). Running on battery alone is not a signal and is not reported.
using System;
using System.Collections.Generic;

namespace Waffle.Windows
{
    sealed class PowerSaving
    {
        /// GUID_POWER_SAVING_STATUS (Windows 10): a DWORD, 1 while battery saver is on.
        public static readonly Guid PowerSavingStatus = new Guid("e00958c0-c213-4ace-ac77-fecced2eeea5");
        /// GUID_ENERGY_SAVER_STATUS (Windows 11): a DWORD, 0 off, 1 standard, 2 high savings.
        public static readonly Guid EnergySaverStatus = new Guid("550e8400-e29b-41d4-a716-446655440000");

        bool statusFlag, batterySaver, energySaver;
        bool? sent;

        public bool LowPower => statusFlag || batterySaver || energySaver;

        /// SYSTEM_POWER_STATUS.SystemStatusFlag: 1 while battery saver (energy saver) is on.
        public void StatusFlag(byte flag) => statusFlag = flag == 1;

        /// A PBT_POWERSETTINGCHANGE value. False for a setting this class does not follow.
        public bool Setting(Guid setting, uint value)
        {
            if (setting == PowerSavingStatus) batterySaver = value != 0;
            else if (setting == EnergySaverStatus) energySaver = value != 0;
            else return false;
            return true;
        }

        /// The state the page reads as globalThis.__atriumPowerState.
        public string State() => Json.Write(new Dictionary<string, object> { ["lowPower"] = LowPower });

        /// The script that tells the page, or null when the page already has this state (force: after a navigation).
        public string Script(bool force)
        {
            if (!force && sent == LowPower) return null;
            sent = LowPower;
            var state = State();
            return "globalThis.__atriumPowerState=" + state + ";window.dispatchEvent(new CustomEvent('atrium-power',{detail:" + state + "}))";
        }
    }
}
