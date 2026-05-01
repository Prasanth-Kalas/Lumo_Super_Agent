from __future__ import annotations

from lumo_ml.pdf_extraction import _elements_to_pages


class _Coordinates:
    points = ((1, 2), (5, 2), (5, 9), (1, 9))


class _Metadata:
    def __init__(self, page_number: int) -> None:
        self.page_number = page_number
        self.coordinates = _Coordinates()


class _Element:
    def __init__(self, text: str, category: str, page_number: int) -> None:
        self.text = text
        self.category = category
        self.metadata = _Metadata(page_number)


def test_elements_to_pages_preserves_layout_shape() -> None:
    pages = _elements_to_pages(
        [
            _Element("Contract", "Title", 1),
            _Element("Clause one", "NarrativeText", 1),
            _Element("Fee | Amount", "Table", 2),
            _Element("First bullet", "ListItem", 2),
        ]
    )

    assert [page.page_number for page in pages] == [1, 2]
    assert [block.type for block in pages[0].blocks] == ["heading", "paragraph"]
    assert [block.type for block in pages[1].blocks] == ["table", "list"]
    assert pages[0].blocks[0].bbox == [1.0, 2.0, 5.0, 9.0]
