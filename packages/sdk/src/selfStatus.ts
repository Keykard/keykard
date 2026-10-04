/** What to tell a person about their latest Self verification attempt (shared by the web app and the Android app). */
export function selfStatusMessage(status: string | null | undefined): { kind: 'info' | 'error'; text: string } | null {
  switch (status) {
    case null:
    case undefined:
    case 'pending':
      return null
    case 'valid':
      return { kind: 'info', text: 'Proof received. Finishing up, this takes a few seconds…' }
    case 'duplicate':
      return {
        kind: 'error',
        text: 'This passport is already linked to another KEYKARD account. One passport can back one account: sign in to that account instead, or verify with a different passport.',
      }
    case 'flow_mismatch':
    case 'test_proof':
      return { kind: 'error', text: 'That proof can’t be used for this account. Tap “Verify with Self” again and finish the steps in the Self app.' }
    case 'expired':
      return { kind: 'error', text: 'The verification link expired. Tap “Verify with Self” to start a new one.' }
    default:
      return { kind: 'error', text: 'Self couldn’t verify you this time. Tap “Verify with Self” to try again.' }
  }
}
