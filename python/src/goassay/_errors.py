class SignerRefusal(Exception):
    """A refusal to sign. ``field`` names the first value that failed its check.

    The message never carries a key or a signature.
    """

    def __init__(self, what: str, field: str, reason: str) -> None:
        super().__init__(f"refusing to sign {what}: {field} {reason}")
        self.field = field
