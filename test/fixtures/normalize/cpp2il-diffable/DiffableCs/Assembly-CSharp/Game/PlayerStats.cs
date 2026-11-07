namespace Game;

public class PlayerStats : MonoBehaviour
{
	private class Cache
	{
		public float last; //Field offset: 0x10

		public Cache() { }
	}

	public float health; //Field offset: 0x20
	[Tooltip("Max")]
	public float maxHealth; //Field offset: 0x24

	public PlayerStats() { }

	private void Update() { }

	public void Heal(float amount) { }
}
