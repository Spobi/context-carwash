// The coding tools Carwash works with, and the few things that differ between
// them in what people see: the tool's name, how the command is typed, and how
// a brief is picked up after /clear.
//
//   Claude Code  /wash is a skill. A brief loads the moment /clear runs, and
//                the status line shows the meter.
//   Codex        $wash is a skill, mentioned with a dollar sign (Codex keeps
//                the slash for its own commands). Codex starts the new session
//                when the first message after /clear is sent, so that is when
//                the brief loads. There is no meter: Codex's status line only
//                shows its own items.

export const TOOLS = {
  claude: {
    id: 'claude',
    name: 'Claude Code',
    model: 'Claude',
    wash: '/wash',
    meter: true,
    afterClear: 'Type /clear to start fresh with it.',
  },
  codex: {
    id: 'codex',
    name: 'Codex',
    model: 'Codex',
    wash: '$wash',
    meter: false,
    afterClear: 'Type /clear, then send your next message (even just "continue"): the brief loads with it.',
  },
};

export const isTool = (id) => Object.hasOwn(TOOLS, id);

// The tool behind a brief or a ledger entry. Everything written before Codex
// support came from Claude Code and carries no tool.
export const toolOf = (thing) => (thing && isTool(thing.tool) ? thing.tool : 'claude');

export const toolInfo = (id) => TOOLS[isTool(id) ? id : 'claude'];
