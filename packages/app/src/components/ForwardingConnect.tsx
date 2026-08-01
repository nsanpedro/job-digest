'use client';

import { useState, useTransition } from 'react';
import { connectForwarding } from '@/lib/actions';
import styles from './ForwardingConnect.module.css';

/**
 * "Add a forwarding mailbox" (design §4.5): generates a unique inbound
 * address and shows the setup instructions. Structurally the highest-trust
 * path — we never request mailbox access — and the one that scales past
 * Google's test-user list, at the cost of the user setting up a forward
 * filter themselves instead of one OAuth click.
 */
export function ForwardingConnect({ existingAddress }: { existingAddress: string | null }) {
  const [address, setAddress] = useState(existingAddress);
  const [pending, startTransition] = useTransition();

  if (address) {
    return (
      <div className={styles.wrap}>
        <p className={styles.label}>Your forwarding address</p>
        <code className={styles.address}>{address}</code>
        <p className={styles.help}>
          In your mail client, set up a filter that forwards mail from LinkedIn, Xing, Indeed and
          StepStone to this address. Nothing else needs to reach it — anything else that arrives
          here is dropped, not stored.
        </p>
      </div>
    );
  }

  return (
    <button
      type="button"
      className={styles.btn}
      disabled={pending}
      onClick={() => startTransition(async () => setAddress((await connectForwarding()).address))}
    >
      Add a forwarding mailbox
    </button>
  );
}
