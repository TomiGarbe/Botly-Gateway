from typing import Literal
from pydantic import BaseModel, Field


class CreateInstanceRequest(BaseModel):
    instance_name: str = Field(..., pattern=r"^[a-z0-9_]{1,64}$")
    qrcode: bool = True
    token: str | None = None
    # Configura el webhook automáticamente al crear la instancia
    auto_configure_webhook: bool = True


class SendTextRequest(BaseModel):
    number: str = Field(..., min_length=5)
    text: str = Field(..., min_length=1, max_length=4096)


class SendMediaRequest(BaseModel):
    number: str
    media_url: str
    mediatype: Literal["image", "video", "audio", "document"]
    caption: str = ""


class SendUploadedMediaRequest(BaseModel):
    number: str
    file_id: str
    mediatype: Literal["image", "video", "audio", "document"]
    caption: str = ""


class ButtonItem(BaseModel):
    display_text: str
    id: str


class SendButtonsRequest(BaseModel):
    number: str
    title: str
    description: str
    footer: str = ""
    buttons: list[ButtonItem]


class ListRow(BaseModel):
    title: str
    description: str = ""
    row_id: str


class ListSection(BaseModel):
    title: str
    rows: list[ListRow]


class SendListRequest(BaseModel):
    number: str
    title: str
    description: str
    button_text: str
    footer_text: str = ""
    sections: list[ListSection]


class CheckNumbersRequest(BaseModel):
    numbers: list[str]
