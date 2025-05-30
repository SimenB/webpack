import toml from "./data.toml";

it("should transform toml to json", () => {
	expect(toml).toMatchObject({
		title: "TOML Example",
		owner: {
			name: 'Tom Preston-Werner',
			organization: 'GitHub',
			bio: 'GitHub Cofounder & CEO\nLikes tater tots and beer.',
			dob: '1979-05-27T07:32:00.000Z'
		}
	});
});
