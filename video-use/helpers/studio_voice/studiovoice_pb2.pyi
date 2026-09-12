from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from typing import ClassVar as _ClassVar, Optional as _Optional

DESCRIPTOR: _descriptor.FileDescriptor

class EnhanceAudioRequest(_message.Message):
    __slots__ = ("audio_stream_data",)
    AUDIO_STREAM_DATA_FIELD_NUMBER: _ClassVar[int]
    audio_stream_data: bytes
    def __init__(self, audio_stream_data: _Optional[bytes] = ...) -> None: ...

class EnhanceAudioResponse(_message.Message):
    __slots__ = ("audio_stream_data",)
    AUDIO_STREAM_DATA_FIELD_NUMBER: _ClassVar[int]
    audio_stream_data: bytes
    def __init__(self, audio_stream_data: _Optional[bytes] = ...) -> None: ...
