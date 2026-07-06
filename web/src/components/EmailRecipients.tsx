import { useEffect, useRef, useState } from 'react';
import { isEmail, parseRecipients } from '@rate-pirate/shared';

/** Tag-style recipient editor: one removable chip per address, plus an input
 *  with a "+" (or Enter / comma) to add. Local state is the source of truth so
 *  edits feel instant; the save is debounced and sends the full latest list, so
 *  rapid add/removes coalesce into one correct write (no lost entries from a
 *  stale settings round-trip). Persists as a comma-joined string via onChange. */
export default function EmailRecipients({
  value,
  onChange,
}: {
  value: string;
  onChange: (emails: string[]) => void;
}) {
  const [emails, setEmails] = useState(() => parseRecipients(value));
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Adopt external changes to the setting (initial load, or edits elsewhere).
  useEffect(() => {
    setEmails(parseRecipients(value));
  }, [value]);

  function commit(next: string[]) {
    setEmails(next);
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => onChange(next), 250);
  }

  function add() {
    const email = draft.trim().replace(/,$/, '');
    if (!email) return;
    if (!isEmail(email)) return setError('Enter a valid email address');
    if (emails.includes(email)) return setError('That address is already added');
    commit([...emails, email]);
    setDraft('');
    setError(null);
  }

  function remove(email: string) {
    commit(emails.filter((e) => e !== email));
  }

  return (
    <div>
      {emails.length > 0 && (
        <ul className="mb-2 flex flex-col gap-2">
          {emails.map((email) => (
            <li
              key={email}
              className="flex items-center justify-between rounded-xl bg-gray-100 py-2 pl-3 pr-2"
            >
              <span className="truncate text-sm font-semibold">{email}</span>
              <button
                type="button"
                aria-label={`Remove ${email}`}
                onClick={() => remove(email)}
                className="-my-2 ml-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-gray-400 active:bg-gray-200"
              >
                <span className="text-lg leading-none">×</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex gap-2">
        <input
          className="min-w-0 flex-1 rounded-xl border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand"
          type="email"
          inputMode="email"
          placeholder="add@example.com"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault();
              add();
            }
          }}
          onBlur={() => {
            // A typed-but-unadded address must not be silently lost on navigation.
            if (draft.trim()) add();
          }}
        />
        <button
          type="button"
          aria-label="Add recipient"
          onClick={add}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand text-xl font-bold text-white active:opacity-80"
        >
          +
        </button>
      </div>

      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
      <p className="mt-2 text-xs text-gray-500">
        {emails.length === 0
          ? 'Add at least one address to receive alerts.'
          : 'Every address here receives each alert.'}
      </p>
    </div>
  );
}
