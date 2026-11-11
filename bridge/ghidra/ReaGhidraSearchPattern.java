import java.util.regex.Pattern;

/**
 * Compiles a caller search pattern only after rewriting it into a bounded
 * linear subset. {@code Pattern.compile} receives quoted literals and constant
 * operator spellings, never the caller string.
 *
 * <p>Allowed: literals (including common escapes and {@code \Q...\E}), {@code .},
 * {@code ^}, {@code $}, {@code \d \D \w \W \s \S}, and one {@code *}, {@code +},
 * or {@code ?} quantifier, optionally reluctant ({@code ?}) or possessive
 * ({@code +}). Groups, alternation, character classes, repetition bounds, and
 * a second quantifier are rejected before compilation.
 */
public final class ReaGhidraSearchPattern {
    /** UTF-16 length above which a caller pattern is refused. */
    public static final int MAX_LENGTH = 256;

    private static final int ATOM_NONE = 0;
    private static final int ATOM_DOT = 1;
    private static final int ATOM_DIGIT = 2;
    private static final int ATOM_NON_DIGIT = 3;
    private static final int ATOM_WORD = 4;
    private static final int ATOM_NON_WORD = 5;
    private static final int ATOM_SPACE = 6;
    private static final int ATOM_NON_SPACE = 7;

    private ReaGhidraSearchPattern() {}

    /** Refusal that names the caller pattern, the reason, and the source index. */
    public static final class Rejected extends IllegalArgumentException {
        private Rejected(String message) {
            super(message);
        }

        static Rejected syntax(String expression, String description, int index) {
            return new Rejected(
                "Invalid regex pattern " + expression + ": " + description + " at index " + index
            );
        }

        static Rejected length(int length) {
            return new Rejected(
                "Invalid regex pattern: pattern length " + length +
                " exceeds " + MAX_LENGTH + " at index " + MAX_LENGTH
            );
        }
    }

    public static Pattern compile(String expression, boolean caseSensitive) {
        String safe = rewrite(expression);
        return Pattern.compile(
            safe,
            caseSensitive ? 0 : Pattern.CASE_INSENSITIVE | Pattern.UNICODE_CASE
        );
    }

    /** Pattern string that {@link #compile} actually compiles. */
    public static String rewrite(String expression) {
        if (expression.length() > MAX_LENGTH) throw Rejected.length(expression.length());
        Draft draft = new Draft(expression);
        for (int index = 0; index < expression.length();) {
            char ch = expression.charAt(index);
            if (ch == '\\') {
                index = draft.escape(index);
                continue;
            }
            if (ch == '^' || ch == '$') {
                draft.flushLiterals();
                draft.flushAtom();
                if (ch == '^') draft.out.append("^");
                else draft.out.append("$");
                index++;
                continue;
            }
            if (ch == '.') {
                draft.predefined(ATOM_DOT);
                index++;
                continue;
            }
            if (ch == '*' || ch == '+' || ch == '?') {
                index = draft.quantify(index, ch);
                continue;
            }
            if (ch == '(' || ch == ')' || ch == '[' || ch == '{' || ch == '|') {
                throw Rejected.syntax(expression, "unsupported regex syntax", index);
            }
            draft.literal(ch);
            index++;
        }
        draft.flushLiterals();
        draft.flushAtom();
        return draft.out.toString();
    }

    private static void appendAtom(StringBuilder out, int atom) {
        switch (atom) {
            case ATOM_DOT -> out.append(".");
            case ATOM_DIGIT -> out.append("\\d");
            case ATOM_NON_DIGIT -> out.append("\\D");
            case ATOM_WORD -> out.append("\\w");
            case ATOM_NON_WORD -> out.append("\\W");
            case ATOM_SPACE -> out.append("\\s");
            case ATOM_NON_SPACE -> out.append("\\S");
            default -> throw new IllegalStateException("missing predefined atom");
        }
    }

    private static void appendQuantifier(
            StringBuilder out,
            char kind,
            boolean reluctant,
            boolean possessive) {
        if (kind == '*') {
            if (possessive) out.append("*+");
            else if (reluctant) out.append("*?");
            else out.append("*");
            return;
        }
        if (kind == '+') {
            if (possessive) out.append("++");
            else if (reluctant) out.append("+?");
            else out.append("+");
            return;
        }
        if (kind == '?') {
            if (possessive) out.append("?+");
            else if (reluctant) out.append("??");
            else out.append("?");
            return;
        }
        throw new IllegalStateException("missing quantifier");
    }

    private static final class Draft {
        private final String expression;
        private final StringBuilder literals = new StringBuilder();
        private final StringBuilder out = new StringBuilder();
        private int atom = ATOM_NONE;
        private boolean quantified;

        private Draft(String expression) {
            this.expression = expression;
        }

        private void flushLiterals() {
            if (literals.length() == 0) return;
            out.append(Pattern.quote(literals.toString()));
            literals.setLength(0);
        }

        private void flushAtom() {
            if (atom == ATOM_NONE) return;
            appendAtom(out, atom);
            atom = ATOM_NONE;
        }

        private void literal(char ch) {
            flushAtom();
            literals.append(ch);
        }

        private void predefined(int next) {
            flushLiterals();
            flushAtom();
            atom = next;
        }

        private int quantify(int index, char kind) {
            boolean reluctant = false;
            boolean possessive = false;
            if (index + 1 < expression.length()) {
                char modifier = expression.charAt(index + 1);
                if (modifier == '?') reluctant = true;
                else if (modifier == '+') possessive = true;
            }
            if (quantified) {
                throw Rejected.syntax(expression, "only one quantifier is supported", index);
            }
            if (atom != ATOM_NONE) {
                appendAtom(out, atom);
                appendQuantifier(out, kind, reluctant, possessive);
                atom = ATOM_NONE;
            }
            else if (literals.length() > 0) {
                char last = literals.charAt(literals.length() - 1);
                literals.setLength(literals.length() - 1);
                flushLiterals();
                out.append(Pattern.quote(String.valueOf(last)));
                appendQuantifier(out, kind, reluctant, possessive);
            }
            else {
                throw Rejected.syntax(
                    expression,
                    "Dangling meta character '" + kind + "'",
                    index
                );
            }
            quantified = true;
            return index + (reluctant || possessive ? 2 : 1);
        }

        private int escape(int index) {
            if (index + 1 >= expression.length()) {
                throw Rejected.syntax(expression, "Illegal/unsupported escape sequence", index);
            }
            char next = expression.charAt(index + 1);
            switch (next) {
                case '\\', '.', '*', '+', '?', '^', '$', '(', ')', '[', ']', '{', '}', '|':
                    literal(next);
                    return index + 2;
                case 'n':
                    literal('\n');
                    return index + 2;
                case 't':
                    literal('\t');
                    return index + 2;
                case 'r':
                    literal('\r');
                    return index + 2;
                case 'f':
                    literal('\f');
                    return index + 2;
                case 'd':
                    predefined(ATOM_DIGIT);
                    return index + 2;
                case 'D':
                    predefined(ATOM_NON_DIGIT);
                    return index + 2;
                case 'w':
                    predefined(ATOM_WORD);
                    return index + 2;
                case 'W':
                    predefined(ATOM_NON_WORD);
                    return index + 2;
                case 's':
                    predefined(ATOM_SPACE);
                    return index + 2;
                case 'S':
                    predefined(ATOM_NON_SPACE);
                    return index + 2;
                case 'Q':
                    return quoted(index + 2);
                case 'u':
                    return unicode(index);
                case 'x':
                    return hexByte(index);
                default:
                    throw Rejected.syntax(expression, "Illegal/unsupported escape sequence", index);
            }
        }

        private int quoted(int index) {
            while (index < expression.length()) {
                if (expression.charAt(index) == '\\' &&
                    index + 1 < expression.length() &&
                    expression.charAt(index + 1) == 'E') {
                    return index + 2;
                }
                literal(expression.charAt(index));
                index++;
            }
            return index;
        }

        private int unicode(int index) {
            if (index + 5 >= expression.length()) {
                throw Rejected.syntax(expression, "Illegal/unsupported escape sequence", index);
            }
            int code = 0;
            for (int offset = 2; offset <= 5; offset++) {
                int digit = Character.digit(expression.charAt(index + offset), 16);
                if (digit < 0) {
                    throw Rejected.syntax(expression, "Illegal/unsupported escape sequence", index);
                }
                code = (code << 4) | digit;
            }
            literal((char) code);
            return index + 6;
        }

        private int hexByte(int index) {
            if (index + 3 >= expression.length() || expression.charAt(index + 2) == '{') {
                throw Rejected.syntax(expression, "Illegal/unsupported escape sequence", index);
            }
            int high = Character.digit(expression.charAt(index + 2), 16);
            int low = Character.digit(expression.charAt(index + 3), 16);
            if (high < 0 || low < 0) {
                throw Rejected.syntax(expression, "Illegal/unsupported escape sequence", index);
            }
            literal((char) ((high << 4) | low));
            return index + 4;
        }
    }
}
