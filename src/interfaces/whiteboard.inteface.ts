interface PositionMouse {
  x: number;
  y: number;
  tool: string;
}

interface MouseUser {
  position: PositionMouse;
  peerId: string;
}

export { PositionMouse, MouseUser };
