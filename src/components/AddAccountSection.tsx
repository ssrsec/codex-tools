import { useI18n } from "../i18n/I18nProvider";

type AddAccountSectionProps = {
  onOpenAddDialog: () => void;
  onSmartSwitch: () => void;
  onCleanupUnavailable: () => void;
  smartSwitching: boolean;
  cleaningUnavailable: boolean;
  cleanupUnavailableCount: number;
};

function SparkIcon() {
  return (
    <svg className="buttonIcon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M12 3v4" />
      <path d="M12 17v4" />
      <path d="M3 12h4" />
      <path d="M17 12h4" />
      <path d="m5.6 5.6 2.8 2.8" />
      <path d="m15.6 15.6 2.8 2.8" />
      <path d="m18.4 5.6-2.8 2.8" />
      <path d="m8.4 15.6-2.8 2.8" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg className="buttonIcon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  );
}

function CleanupIcon() {
  return (
    <svg className="buttonIcon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M4 7h16" />
      <path d="M9 7V4h6v3" />
      <path d="m7 7 1 13h8l1-13" />
    </svg>
  );
}

export function AddAccountSection({
  onOpenAddDialog,
  onSmartSwitch,
  onCleanupUnavailable,
  smartSwitching,
  cleaningUnavailable,
  cleanupUnavailableCount,
}: AddAccountSectionProps) {
  const { copy } = useI18n();

  return (
    <section className="importBar">
      <button
        className="ghost dangerTextButton importCleanup"
        onClick={onCleanupUnavailable}
        disabled={cleaningUnavailable || cleanupUnavailableCount === 0}
        title={`${copy.addAccount.cleanupUnavailable} (${cleanupUnavailableCount})`}
      >
        <CleanupIcon />
        {cleaningUnavailable
          ? copy.addAccount.cleaningUnavailable
          : `${copy.addAccount.cleanupUnavailable} (${cleanupUnavailableCount})`}
      </button>
      <button
        className="ghost smartSwitchButton importSmartSwitch"
        onClick={onSmartSwitch}
        disabled={smartSwitching}
        title={copy.addAccount.smartSwitch}
        aria-label={copy.addAccount.smartSwitch}
      >
        <SparkIcon />
        {copy.addAccount.smartSwitch}
      </button>
      <button
        className="primary importPrimary"
        onClick={onOpenAddDialog}
      >
        <PlusIcon />
        {copy.addAccount.startButton}
      </button>
    </section>
  );
}
