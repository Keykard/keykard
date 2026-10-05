export default function Failed() {
  return (
    <main className="wrap center">
      <div className="panel" style={{ marginTop: 48 }}>
        <div style={{ fontSize: 44, lineHeight: 1, color: 'var(--kc-bad)' }} aria-hidden>×</div>
        <h1 style={{ fontSize: '1.8rem' }}>Verification didn’t complete</h1>
        <p className="muted">Your Self verification wasn’t accepted. Go back to the KEYKARD tab and try again. KEYKARD is not available to residents of, or passports issued by, excluded countries.</p>
      </div>
    </main>
  )
}
