import java.util.regex.Pattern;

/** Compares the safe search subset with Java's matcher and refuses the rest. */
public final class ReaGhidraSearchPatternTest {
    public static void main(String[] args) {
        same("projection.*", false, "Projection.keep", "nope", "xxprojection.y");
        same("^δ", true, "δx", "xδ", "Δx");
        same("^δ", false, "Δx", "δ", "xδ");
        same("a.b", true, "axb", "a.b", "ab", "a\nb");
        same(".", true, "a", "\n", "");
        same("fixture", false, "Fixture", "xxfixtureyy", "fix");
        same("!$", true, "!", "a!", "a!b");
        same("foo*", true, "fo", "foo", "fooo", "f", "xfooy", "foX");
        same("foo*?", true, "fo", "fooo", "f");
        same("a*+", true, "", "aaa", "b");
        same("a\\.b", true, "a.b", "axb");
        same("\\d+", true, "a12b", "ab", "9");
        same("\\d", true, "a1", "ab", "9");
        same("id\\d", true, "id5", "id", "idx");
        same("\\s+", true, "a  b", "ab");
        same("\\w", true, "a", "-");
        same("\\Q.*\\E", true, ".*", "ab");
        same("\\u03b4", true, "δ", "d");
        same("\\x41", true, "A", "B");
        same("]", true, "]", "a", "]a");
        same("a}", true, "a}", "a");
        same("^a$", true, "a", "ba", "ab");
        same("", true, "abc", "");
        same("a.*", true, "axb", "a", "b");
        same("^a.*b", true, "axb", "a\nb", "ab", "zzaxxxb");
        same("\\n", true, "\n", "n");
        same("Foo", false, "foo", "FOO", "bar");
        same(".*", true, "", "abc", "a\nb");
        same("^.*", true, "abc", "");
        same("^.*$", true, "abc", "");
        String emoji = "\uD83D\uDE00";
        same(emoji, true, emoji, "x");
        same(emoji + "+", true, emoji, emoji + emoji, emoji + "x", "x");
        same("a" + emoji + "+", true, "a" + emoji + emoji, "a" + emoji, emoji);
        same("\\uD83D\\uDE00+", true, emoji, emoji + emoji, "x");
        String mixed = emoji.substring(0, 1) + "\\uDE00";
        same(mixed, true, emoji, emoji.substring(0, 1));
        same(mixed + "+", true, emoji, emoji + emoji);
        String high = emoji.substring(0, 1);
        String low = emoji.substring(1);
        same("\\Q" + emoji + "\\E", true, emoji, "x");
        same("\\Q" + emoji + "\\E+", true, emoji, emoji + emoji, "x");
        same(high + "\\Q" + low + "\\E", true, emoji, high);
        same("\\Q" + high + "\\E" + low, true, emoji, high);
        same("\\Q" + high + "\\E\\Q" + low + "\\E", true, emoji, high);
        String longAs = "a".repeat(20000);
        same("^a+b", true, longAs + "b", longAs, "b");
        if (!ReaGhidraSearchPattern.rewrite("projection.*").equals(Pattern.quote("projection") + ".*")) {
            throw new AssertionError(ReaGhidraSearchPattern.rewrite("projection.*"));
        }
        if (!ReaGhidraSearchPattern.rewrite("\\d+").equals("\\d+")) {
            throw new AssertionError(ReaGhidraSearchPattern.rewrite("\\d+"));
        }

        rejects("[", "unsupported regex syntax", 0);
        rejects("(", "unsupported regex syntax", 0);
        rejects(")", "unsupported regex syntax", 0);
        rejects("|", "unsupported regex syntax", 0);
        rejects("a|b", "unsupported regex syntax", 1);
        rejects("(a+)+", "unsupported regex syntax", 0);
        rejects("^(a|aa)*b$", "unsupported regex syntax", 1);
        rejects("^a*b*", "only one quantifier is supported", 4);
        rejects("a*b*", "quantifier must end an unanchored pattern", 2);
        rejects("a*b", "quantifier must end an unanchored pattern", 2);
        rejects("a+b", "quantifier must end an unanchored pattern", 2);
        rejects(".*$", "quantifier must end an unanchored pattern", 2);
        rejects("a.*b", "quantifier must end an unanchored pattern", 3);
        rejects(".*foo.*", "quantifier must end an unanchored pattern", 2);
        rejects("a{2}", "unsupported regex syntax", 1);
        rejects("*", "Dangling meta character '*'", 0);
        rejects("+", "Dangling meta character '+'", 0);
        rejects("\\", "Illegal/unsupported escape sequence", 0);
        rejects("\\p{L}", "Illegal/unsupported escape sequence", 0);
        rejects("\\1", "Illegal/unsupported escape sequence", 0);
        rejects("a".repeat(ReaGhidraSearchPattern.MAX_LENGTH + 1), "exceeds " + ReaGhidraSearchPattern.MAX_LENGTH, ReaGhidraSearchPattern.MAX_LENGTH);
        String nested = "(".repeat(12000) + "a" + ")".repeat(12000);
        ReaGhidraSearchPattern.Rejected length = rejectOnly(nested);
        if (length.getMessage().contains("(") || length.getMessage().length() > 120) {
            throw new AssertionError(length.getMessage());
        }
        if (!length.getMessage().contains("pattern length 24001 exceeds 256 at index 256")) {
            throw new AssertionError(length.getMessage());
        }
        System.out.println("ok");
    }

    private static void same(String pattern, boolean caseSensitive, String... samples) {
        int flags = caseSensitive ? 0 : Pattern.CASE_INSENSITIVE | Pattern.UNICODE_CASE;
        Pattern direct = Pattern.compile(pattern, flags);
        Pattern safe = ReaGhidraSearchPattern.compile(pattern, caseSensitive);
        for (String sample : samples) {
            boolean expected = direct.matcher(sample).find();
            boolean actual = safe.matcher(sample).find();
            if (expected != actual) {
                throw new AssertionError(
                    pattern + " on " + sample + " direct=" + expected + " safe=" + actual +
                    " rewritten=" + ReaGhidraSearchPattern.rewrite(pattern)
                );
            }
        }
    }

    private static void rejects(String pattern, String description, int index) {
        ReaGhidraSearchPattern.Rejected rejected = rejectOnly(pattern);
        String message = rejected.getMessage();
        if (!message.contains("Invalid regex pattern") || !message.contains("index")) {
            throw new AssertionError(message);
        }
        if (!message.contains(description) || !message.contains("at index " + index)) {
            throw new AssertionError(message);
        }
        if (pattern.length() <= ReaGhidraSearchPattern.MAX_LENGTH && !message.contains(pattern)) {
            throw new AssertionError(message);
        }
    }

    private static ReaGhidraSearchPattern.Rejected rejectOnly(String pattern) {
        try {
            ReaGhidraSearchPattern.compile(pattern, true);
        }
        catch (ReaGhidraSearchPattern.Rejected rejected) {
            return rejected;
        }
        throw new AssertionError("accepted " + pattern);
    }
}
